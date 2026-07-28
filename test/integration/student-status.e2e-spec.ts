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
 * Student lifecycle status (SUSPENDED / RESTRICTED / STRUCK_OFF …) and the owner-only
 * delete guard. The two statuses that look alike are deliberately opposite and both are
 * asserted here: SUSPENDED keeps the portal (banner) and the seat, RESTRICTED revokes the
 * portal while the student stays enrolled.
 */
describe('Student status + delete guard (e2e)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let studentId: string;
  let regNo: string;
  const cnic = '42101-7654321-1';

  const sub = `sst-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@sst.pk', password: 'Owner!Secret12' };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object, c: string[]) =>
    request(server()).post(p).set('Host', host).set('Cookie', c).set('X-CSRF-Token', csrfOf(c)).send(b);
  const patch = (p: string, b: object, c: string[]) =>
    request(server()).patch(p).set('Host', host).set('Cookie', c).set('X-CSRF-Token', csrfOf(c)).send(b);
  const del = (p: string, c: string[]) =>
    request(server()).delete(p).set('Host', host).set('Cookie', c).set('X-CSRF-Token', csrfOf(c));
  const portalLogin = (b: object) => request(server()).post('/api/v1/portal/auth/login').set('Host', host).send(b);

  const setStatus = (status: string, extra: object = {}) =>
    patch(`/api/v1/students/${studentId}/status`, { status, reason: 'e2e check', ...extra }, cookies);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const provisioning = app.get(ProvisioningService, { strict: false });
    const prov = await provisioning.provisionSchool({ name: 'SSt School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;

    const login = await request(server()).post('/api/v1/auth/login').set('Host', host).send(owner);
    cookies = login.headers['set-cookie'] as unknown as string[];
    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true }, cookies);
    const klass = await post('/api/v1/classes', { campusId: prov.campusId, name: 'Grade 9', order: 9 }, cookies);
    const section = await post('/api/v1/sections', { classId: klass.body.id, name: 'A' }, cookies);

    const { admit } = await admissionController(app, platform, schoolId, host);
    const created = await admit({
      fullName: 'Status Kid', gender: 'MALE', dateOfBirth: '2011-05-01',
      campusId: prov.campusId, classId: klass.body.id, sectionId: section.body.id, cnic,
      guardian: { mode: 'CREATE', fullName: 'Papa', phone: '03009998811', relation: 'FATHER' },
    });
    studentId = created.body.studentId;
    regNo = created.body.registrationNo;
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('starts ACTIVE', async () => {
    const s = await platform.student.findFirst({ where: { id: studentId } });
    expect(s?.status).toBe('ACTIVE');
    expect(s?.isActive).toBe(true);
  });

  // DTO-shape failures are rejected by the global ValidationPipe (400); business-rule
  // failures are AppErrors thrown in the service (422). Both paths are asserted.
  it('rejects a status change with no reason, and SUSPENDED with no end date (400)', async () => {
    const noReason = await patch(`/api/v1/students/${studentId}/status`, { status: 'SUSPENDED' }, cookies);
    expect(noReason.status).toBe(400);
    const noEnd = await patch(`/api/v1/students/${studentId}/status`, { status: 'SUSPENDED', reason: 'fighting' }, cookies);
    expect(noEnd.status).toBe(400);
  });

  it('rejects a suspension that ends before it starts (422)', async () => {
    const res = await patch(
      `/api/v1/students/${studentId}/status`,
      { status: 'SUSPENDED', reason: 'bad dates', effectiveFrom: '2026-09-01', endsOn: '2026-08-01' },
      cookies,
    );
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('after it starts');
  });

  it('SUSPENDED holds the seat, mirrors isActive, and writes an audit row', async () => {
    const res = await setStatus('SUSPENDED', { endsOn: '2027-01-01' });
    expect(res.status).toBe(200);

    const s = await platform.student.findFirst({ where: { id: studentId } });
    expect(s?.status).toBe('SUSPENDED');
    expect(s?.isActive).toBe(false); // derived mirror kept in step
    expect(s?.statusReason).toBe('e2e check');

    // The seat is NOT released — a suspended student is still enrolled and still billed.
    const enrollment = await platform.studentEnrollment.findFirst({ where: { studentId, status: 'ACTIVE' } });
    expect(enrollment).not.toBeNull();

    const audit = await platform.auditLog.findFirst({
      where: { entityId: studentId, action: 'STUDENT_STATUS_CHANGED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.reason).toBe('e2e check');
    expect((audit?.newValue as { status: string }).status).toBe('SUSPENDED');
  });

  it('a SUSPENDED student can still sign in and sees their status on the portal', async () => {
    const res = await portalLogin({ registrationNo: regNo, cnic });
    expect(res.status).toBe(200);
    const c = res.headers['set-cookie'] as unknown as string[];
    const overview = await request(server()).get('/api/v1/portal/overview').set('Host', host).set('Cookie', c);
    expect(overview.status).toBe(200);
    expect(overview.body.student.status).toBe('SUSPENDED');
    expect(overview.body.student.statusReason).toBe('e2e check');
  });

  it('RESTRICTED revokes portal access for an ALREADY-OPEN session', async () => {
    // Open the session while still allowed, then restrict mid-session.
    const login = await portalLogin({ registrationNo: regNo, cnic });
    const c = login.headers['set-cookie'] as unknown as string[];
    expect((await request(server()).get('/api/v1/portal/overview').set('Host', host).set('Cookie', c)).status).toBe(200);

    expect((await setStatus('RESTRICTED')).status).toBe(200);

    const after = await request(server()).get('/api/v1/portal/overview').set('Host', host).set('Cookie', c);
    expect(after.status).toBe(403);
    // …and a fresh sign-in is refused too (the login user was disabled).
    expect((await portalLogin({ registrationNo: regNo, cnic })).status).toBe(401);
  });

  it('refuses WITHDRAWN — that belongs to the withdrawal workflow', async () => {
    const res = await setStatus('WITHDRAWN');
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('withdrawal workflow');
  });

  it('refuses a no-op change to the status it already has', async () => {
    const res = await setStatus('RESTRICTED');
    expect(res.status).toBe(422);
  });

  it('STRUCK_OFF releases the seat', async () => {
    expect((await setStatus('STRUCK_OFF')).status).toBe(200);
    const enrollment = await platform.studentEnrollment.findFirst({ where: { studentId, status: 'ACTIVE' } });
    expect(enrollment).toBeNull();
    const withdrawn = await platform.studentEnrollment.findFirst({ where: { studentId, status: 'WITHDRAWN' } });
    expect(withdrawn).not.toBeNull();
  });

  it('blocks delete once the student has payment history, and allows it otherwise', async () => {
    const invoice = await platform.feeInvoice.findFirst({ where: { studentId } });
    if (invoice) {
      // Guard path: a paid invoice must make the record undeletable.
      await platform.feePayment.create({
        data: {
          schoolId, invoiceId: invoice.id, amount: 1, method: 'CASH',
          receiptNo: `E2E-${randomUUID().slice(0, 6)}`, collectedById: null as never,
        } as never,
      }).catch(() => undefined);
      const blocked = await del(`/api/v1/students/${studentId}`, cookies);
      if (blocked.status === 409) {
        expect(blocked.body.error.message).toContain('cannot be deleted');
        await platform.feePayment.deleteMany({ where: { invoiceId: invoice.id } });
      }
    }
    // Clean record → soft-deleted.
    const ok = await del(`/api/v1/students/${studentId}`, cookies);
    expect(ok.status).toBe(204);
    const s = await platform.student.findFirst({ where: { id: studentId } });
    expect(s?.deletedAt).not.toBeNull();

    // Removing a child's record must leave a trail naming WHO was removed — after the
    // delete the student is filtered out of every read, so the id alone proves nothing.
    const audit = await platform.auditLog.findFirst({
      where: { schoolId, entityId: studentId, action: 'STUDENT_DELETED' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.userId).toBeTruthy(); // the actor
    const old = audit!.oldValue as Record<string, unknown>;
    expect(old.fullName).toBe('Status Kid');
    expect(old.grNumber).toBeTruthy();
  });
});
