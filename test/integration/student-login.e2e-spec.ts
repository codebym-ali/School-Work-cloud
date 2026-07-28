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

    const login = await request(server()).post('/api/v1/auth/login').set('Host', host).send(owner);
    const cookies = login.headers['set-cookie'] as unknown as string[];
    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true }, cookies);
    const klass = await post('/api/v1/classes', { campusId: prov.campusId, name: 'Grade 9', order: 9 }, cookies);
    const section = await post('/api/v1/sections', { classId: klass.body.id, name: 'A' }, cookies);

    // Admission controller admits a student WITH a CNIC → provisions the portal login.
    const { admit } = await admissionController(app, platform, schoolId, host);
    const created = await admit({
      fullName: 'Login Kid', gender: 'MALE', dateOfBirth: '2011-05-01',
      campusId: prov.campusId, classId: klass.body.id, sectionId: section.body.id, cnic,
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

  it('a soft-deleted student cannot sign in', async () => {
    await platform.student.update({ where: { id: studentId }, data: { deletedAt: new Date() } });
    const res = await portalLogin({ registrationNo: regNo, cnic });
    expect(res.status).toBe(401);
    await platform.student.update({ where: { id: studentId }, data: { deletedAt: null } });
  });
});
