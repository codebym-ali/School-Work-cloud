import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { admissionController } from './support/admission';
import { destroyTenant } from './support/tenant';
import { loginRequest } from './support/login';
import { enrolMfa } from './support/mfa';
import { opsAdminSession } from './support/ops-admin';

/**
 * Student portal sign-in by registration number + CNIC (§28). The direct-admission flow
 * provisions the login (User(STUDENT) + cnicHash); this proves the credential works, is
 * enumeration-safe, and that a removed student cannot sign in.
 */
describe('Student login: reg-no + CNIC (e2e, §28)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let regNo: string;
  let studentId: string;
  let campusId: string;
  let classId: string;
  let sectionId: string;
  /** One admission-controller session for the whole spec — the helper mints a deterministic
   *  email per campus, so calling it twice for the same campus collides on (school, email). */
  let admit: (dto: object) => request.Test;
  let opsCookies: string[];
  const cnic = '42101-1234567-9';

  const sub = `slog-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@slog.pk', password: 'Owner!Secret12' };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object, c: string[]) =>
    request(server()).post(p).set('Host', host).set('Cookie', c).set('X-CSRF-Token', csrfOf(c)).send(b);
  const portalLogin = (b: object) => request(server()).post('/api/v1/portal/auth/login').set('Host', host).send(b);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const provisioning = app.get(ProvisioningService, { strict: false });
    const prov = await provisioning.provisionSchool({ name: 'SLog School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;
    campusId = prov.campusId;

    const login = await loginRequest(server(), host, owner.email, owner.password);
    // Enrolled once, here: revealing a CNIC is two-factor gated. The later owner sign-ins in this file
    // complete the challenge through support/login.ts, so they need no change.
    const cookies = await enrolMfa(server(), host, login.headers['set-cookie'] as unknown as string[]);
    const ops = await opsAdminSession(app, platform, schoolId, host, 'ops@slog.pk', campusId);
    opsCookies = ops.cookies;
    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true }, cookies);
    const klass = await post('/api/v1/classes', { campusId, name: 'Grade 9', order: 9 }, opsCookies);
    classId = klass.body.id;
    const section = await post('/api/v1/sections', { classId, name: 'A' }, opsCookies);
    sectionId = section.body.id;

    // Admission controller admits a student WITH a CNIC → provisions the portal login.
    ({ admit } = await admissionController(app, platform, schoolId, host, campusId));
    const created = await admit({
      fullName: 'Login Kid', gender: 'MALE', dateOfBirth: '2011-05-01',
      campusId, classId, sectionId, cnic,
      guardian: { mode: 'CREATE', fullName: 'Papa', phone: '03007654321', relation: 'FATHER' },
    });
    regNo = created.body.registrationNo;
    studentId = created.body.studentId;
    expect(created.body.loginProvisioned).toBe(true);
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('signs in with the registration number + CNIC and opens a STUDENT session', async () => {
    const res = await portalLogin({ registrationNo: regNo, cnic });
    expect(res.status).toBe(200);
    expect(res.body.user.roles).toEqual(['STUDENT']);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    // The session can read the student self-portal.
    const overview = await request(server()).get('/api/v1/portal/overview').set('Host', host).set('Cookie', cookies);
    expect(overview.status).toBe(200);
  });

  it('rejects a wrong CNIC and a wrong registration number with the SAME error (enumeration-safe)', async () => {
    const badCnic = await portalLogin({ registrationNo: regNo, cnic: '42101-0000000-0' });
    const badReg = await portalLogin({ registrationNo: '999999', cnic });
    expect(badCnic.status).toBe(401);
    expect(badReg.status).toBe(401);
    expect(badCnic.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(badReg.body.error.message).toBe(badCnic.body.error.message);
  });

  it('an admin can reveal the CNIC, it round-trips, and the reveal is audited', async () => {
    const login = await loginRequest(server(), host, owner.email, owner.password);
    const ownerCookies = login.headers['set-cookie'] as unknown as string[];

    // The profile carries presence, never the value — the ciphertext must not ride along.
    const profile = await request(server()).get(`/api/v1/students/${studentId}`).set('Host', host).set('Cookie', ownerCookies);
    expect(profile.status).toBe(200);
    expect(profile.body.hasCnic).toBe(true);
    expect(profile.body.portalLoginEnabled).toBe(true);
    expect(JSON.stringify(profile.body)).not.toContain(cnic);
    expect(profile.body.cnicEnc).toBeUndefined();
    expect(profile.body.cnicHash).toBeUndefined();

    const before = await platform.auditLog.count({ where: { schoolId, action: 'STUDENT_CNIC_REVEALED' } });
    const res = await request(server()).get(`/api/v1/students/${studentId}/cnic`).set('Host', host).set('Cookie', ownerCookies);
    expect(res.status).toBe(200);
    expect(res.body.cnic).toBe(cnic); // decrypts back to exactly what was typed at admission
    const after = await platform.auditLog.count({ where: { schoolId, action: 'STUDENT_CNIC_REVEALED' } });
    expect(after).toBe(before + 1);

    // The audit row records WHO was revealed, never the number itself.
    const row = await platform.auditLog.findFirst({
      where: { schoolId, action: 'STUDENT_CNIC_REVEALED' }, orderBy: { createdAt: 'desc' },
    });
    expect(JSON.stringify(row?.newValue)).not.toContain(cnic);
    expect(row?.userId).toBeTruthy();

    // Revealing does not disturb the login factor.
    const stillWorks = await portalLogin({ registrationNo: regNo, cnic });
    expect(stillWorks.status).toBe(200);
  });

  /** The route the admission screen had been promising all along: a student admitted without a
   *  CNIC could never get a portal login, and a CNIC captured before `cnic_enc` existed could
   *  verify a sign-in but never be read back. One endpoint closes both. */
  it('records a CNIC after admission, provisioning the login, and the student can then sign in', async () => {
    const login = await loginRequest(server(), host, owner.email, owner.password);
    const ownerCookies = login.headers['set-cookie'] as unknown as string[];

    // A second student admitted with NO cnic — so no portal login at all.
    const late = await admit({
      fullName: 'Late Cnic', gender: 'MALE', dateOfBirth: '2013-06-06',
      campusId, classId, sectionId,
      guardian: { mode: 'CREATE', fullName: 'L Parent', phone: '03119990001', relation: 'FATHER' },
    });
    const lateId = late.body.studentId as string;
    const lateReg = late.body.registrationNo as string;

    const before = await platform.student.findFirst({ where: { id: lateId }, select: { userId: true } });
    expect(before?.userId).toBeNull(); // no login — the state this endpoint exists to fix

    const lateCnic = '42101-5556667-8';
    const opsCsrf = csrfOf(opsCookies);
    const res = await request(server()).patch(`/api/v1/students/${lateId}/cnic`)
      .set('Host', host).set('Cookie', opsCookies).set('X-CSRF-Token', opsCsrf)
      .send({ cnic: lateCnic });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ loginProvisioned: true, replacedExisting: false });

    // The login now exists AND works — indistinguishable from one created at admission.
    const signIn = await portalLogin({ registrationNo: lateReg, cnic: lateCnic });
    expect(signIn.status).toBe(200);

    // And it is revealable, which a hash-only record never was.
    const reveal = await request(server()).get(`/api/v1/students/${lateId}/cnic`).set('Host', host).set('Cookie', ownerCookies);
    expect(reveal.body.cnic).toBe(lateCnic);

    // Audited as a first capture, with identity but never the number.
    const row = await platform.auditLog.findFirst({
      where: { schoolId, action: 'STUDENT_CNIC_SET' }, orderBy: { createdAt: 'desc' },
    });
    expect(row?.newValue).toMatchObject({ replacedExisting: false, loginProvisioned: true });
    expect(JSON.stringify(row?.newValue)).not.toContain(lateCnic);
  });

  it('replacing a CNIC retires the old one as a credential, and refuses a duplicate', async () => {
    const opsCsrf = csrfOf(opsCookies);
    const patch = (id: string, c: string) =>
      request(server()).patch(`/api/v1/students/${id}/cnic`)
        .set('Host', host).set('Cookie', opsCookies).set('X-CSRF-Token', opsCsrf).send({ cnic: c });

    const replacement = '42101-1111222-3';
    const res = await patch(studentId, replacement);
    expect(res.body.replacedExisting).toBe(true);

    // The OLD number stops working immediately — this is a live credential change, which is
    // exactly why the endpoint is admin-only and audited.
    expect((await portalLogin({ registrationNo: regNo, cnic })).status).toBe(401);
    expect((await portalLogin({ registrationNo: regNo, cnic: replacement })).status).toBe(200);

    // Two students cannot share a CNIC — the portal resolves a login by (regNo, cnicHash), so a
    // duplicate is a data-entry error worth naming rather than an ambiguity to discover later.
    const other = await platform.student.findFirst({ where: { schoolId, NOT: { id: studentId } }, select: { id: true } });
    if (other) {
      const clash = await patch(other.id, replacement);
      expect(clash.status).toBe(409);
      expect(clash.body.error.message).toContain('already recorded for');
    }

    // Restore so later cases in this spec still see the original credential.
    await patch(studentId, cnic);
  });

  it('a soft-deleted student cannot sign in', async () => {
    await platform.student.update({ where: { id: studentId }, data: { deletedAt: new Date() } });
    const res = await portalLogin({ registrationNo: regNo, cnic });
    expect(res.status).toBe(401);
    await platform.student.update({ where: { id: studentId }, data: { deletedAt: null } });
  });
});
