import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { admissionController } from './support/admission';
import { SMS_QUEUE } from '../../apps/api/src/modules/comms/sms/sms.types';

/** M3 leaves (§10): request -> overlap guard -> approve (writes ON_LEAVE) -> reject/cancel + state machine. */
describe('Leaves (e2e, §10)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let csrf: string;
  let studentId: string;

  const sub = `lv-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const email = 'owner@lv.pk';
  const password = 'Owner!Secret12';

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object = {}) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).send(b);
  const get = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const provisioning = app.get(ProvisioningService, { strict: false });
    const prov = await provisioning.provisionSchool({ name: 'Lv School', subdomain: sub, ownerEmail: email, ownerPassword: password });
    schoolId = prov.schoolId;

    const login = await request(server()).post('/api/v1/auth/login').set('Host', host).send({ email, password });
    cookies = login.headers['set-cookie'] as unknown as string[];
    csrf = csrfOf(cookies);

    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    const klass = await post('/api/v1/classes', { campusId: prov.campusId, name: 'Grade 1', order: 1 });
    const section = await post('/api/v1/sections', { classId: klass.body.id, name: 'A' });
    const { admit } = await admissionController(app, platform, schoolId, host);
    const student = await admit({
      fullName: 'Sara Khan', gender: 'FEMALE', dateOfBirth: '2020-05-10',
      campusId: prov.campusId, classId: klass.body.id, sectionId: section.body.id,
      guardian: { mode: 'CREATE', fullName: 'Ali Khan', phone: '03007654321', relation: 'FATHER' },
    });
    studentId = student.body.studentId;
  });

  afterAll(async () => {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    const tables = [
      'auditLog', 'smsLog', 'smsCreditLedger', 'smsTemplate', 'attendanceRecord', 'studentLeave', 'admission',
      'entryTest', 'studentGuardian', 'studentEnrollment', 'student', 'inquiry', 'parentProfile',
      'refreshToken', 'user', 'subject', 'section', 'class', 'academicYear', 'campus', 'school',
    ] as const;
    for (const t of tables) {
      const d = platform[t] as unknown as { deleteMany: (a: unknown) => Promise<unknown> };
      await d.deleteMany({ where: t === 'school' ? { id: schoolId } : { schoolId } }).catch(() => undefined);
    }
    await app.close();
  });

  it('creates a PENDING leave and rejects an overlapping one (409 LEAVE_OVERLAP)', async () => {
    const first = await post('/api/v1/student-leaves', { studentId, fromDate: '2026-06-01', toDate: '2026-06-02', reason: 'Travel' });
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('PENDING');

    const overlap = await post('/api/v1/student-leaves', { studentId, fromDate: '2026-06-02', toDate: '2026-06-03', reason: 'Again' });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('LEAVE_OVERLAP');
  });

  it('approving a leave writes ON_LEAVE attendance across the range', async () => {
    const leaves = await get('/api/v1/student-leaves?status=PENDING');
    const leaveId = leaves.body.data[0].id;

    const approved = await post(`/api/v1/student-leaves/${leaveId}/approve`);
    expect(approved.status).toBe(201);
    expect(approved.body.status).toBe('APPROVED');

    const att = await get(`/api/v1/attendance?studentId=${studentId}&from=2026-06-01&to=2026-06-02`);
    expect(att.body.length).toBe(2); // 2 days x MORNING session
    expect(att.body.every((r: { status: string }) => r.status === 'ON_LEAVE')).toBe(true);
  });

  it('rejects a leave (reason required) and forbids re-deciding it', async () => {
    const created = await post('/api/v1/student-leaves', { studentId, fromDate: '2026-07-01', toDate: '2026-07-01', reason: 'Sick' });
    const id = created.body.id;

    const rejected = await post(`/api/v1/student-leaves/${id}/reject`, { reason: 'Insufficient notice' });
    expect(rejected.status).toBe(201);
    expect(rejected.body.status).toBe('REJECTED');

    const reApprove = await post(`/api/v1/student-leaves/${id}/approve`);
    expect(reApprove.status).toBe(409);
    expect(reApprove.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('cancels a PENDING leave', async () => {
    const created = await post('/api/v1/student-leaves', { studentId, fromDate: '2026-08-01', toDate: '2026-08-02', reason: 'Trip' });
    const cancelled = await post(`/api/v1/student-leaves/${created.body.id}/cancel`);
    expect(cancelled.status).toBe(201);
    expect(cancelled.body.status).toBe('CANCELLED');
  });
});
