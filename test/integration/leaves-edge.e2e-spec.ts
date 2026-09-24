import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { SMS_QUEUE } from '../../apps/api/src/modules/comms/sms/sms.types';
import { admissionController } from './support/admission';
import { destroyTenant } from './support/tenant';
import { loginRequest } from './support/login';

/**
 * Leaves — edge rules not covered by leaves.e2e (overlap/approve/reject/cancel state machine) or
 * staff-leaves.e2e (quota/pay/register): the date-order guard on both leave kinds, and — the one with real
 * semantics — that CANCELLING a leave FREES its dates, so a replacement over the same range is accepted
 * (a cancelled leave no longer counts as PENDING/APPROVED in the overlap check).
 */
describe('Leaves — date guard & cancel frees the slot (e2e, §10)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let csrf: string;
  let studentId: string;
  let staffId: string;
  const host = `lve-${randomUUID().slice(0, 6)}.localhost`;
  const email = 'owner@lve.pk';
  const password = 'Owner!Secret12';

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, body: object = {}) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).set('Idempotency-Key', randomUUID()).send(body);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    platform = app.get(PlatformPrismaService);

    const prov = await app.get(ProvisioningService, { strict: false }).provisionSchool({ name: 'Leave School', subdomain: host.split('.')[0], ownerEmail: email, ownerPassword: password });
    schoolId = prov.schoolId;
    cookies = (await loginRequest(server(), host, email, password)).headers['set-cookie'] as unknown as string[];
    csrf = csrfOf(cookies);

    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    const classId = (await post('/api/v1/classes', { campusId: prov.campusId, name: 'Grade 1', order: 1 })).body.id;
    const sectionId = (await post('/api/v1/sections', { classId, name: 'A' })).body.id;
    const { admit } = await admissionController(app, platform, schoolId, host, prov.campusId);
    studentId = (await admit({
      fullName: 'Leave Child', gender: 'MALE', dateOfBirth: '2018-05-10', campusId: prov.campusId, classId, sectionId,
      guardian: { mode: 'CREATE', fullName: 'Leave Guardian', phone: '03007654321', relation: 'FATHER' },
    })).body.studentId;
    staffId = (await post('/api/v1/staff', {
      email: 'teacher@lve.pk', campusId: prov.campusId, staffType: 'TEACHER',
      employeeCode: `EMP-${randomUUID().slice(0, 6)}`, designation: 'Teacher', joinedAt: '2026-04-01', fullName: 'Leave Teacher',
    })).body.staffId;
  }, 120_000);

  afterAll(async () => {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    if (schoolId) await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('rejects a student leave whose toDate precedes its fromDate (422)', async () => {
    const res = await post('/api/v1/student-leaves', { studentId, fromDate: '2026-06-10', toDate: '2026-06-05', reason: 'backwards' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a staff leave whose toDate precedes its fromDate (422)', async () => {
    const res = await post('/api/v1/staff-leaves', { staffId, leaveType: 'UNPAID', fromDate: '2026-06-10', toDate: '2026-06-05', reason: 'backwards' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('cancelling a student leave frees its dates for a replacement', async () => {
    const first = await post('/api/v1/student-leaves', { studentId, fromDate: '2026-07-01', toDate: '2026-07-03', reason: 'trip' });
    expect(first.status).toBe(201);
    // Same dates while the first is live → blocked.
    const blocked = await post('/api/v1/student-leaves', { studentId, fromDate: '2026-07-01', toDate: '2026-07-03', reason: 'again' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('LEAVE_OVERLAP');
    // Cancel the first, then the same dates are accepted — the slot is freed, not held forever.
    expect((await post(`/api/v1/student-leaves/${first.body.id}/cancel`)).status).toBe(201);
    const replacement = await post('/api/v1/student-leaves', { studentId, fromDate: '2026-07-01', toDate: '2026-07-03', reason: 'rebooked' });
    expect(replacement.status).toBe(201);
  });

  it('cancelling a staff leave frees its dates for a replacement', async () => {
    const first = await post('/api/v1/staff-leaves', { staffId, leaveType: 'UNPAID', fromDate: '2026-08-01', toDate: '2026-08-02', reason: 'personal' });
    expect(first.status).toBe(201);
    const blocked = await post('/api/v1/staff-leaves', { staffId, leaveType: 'UNPAID', fromDate: '2026-08-01', toDate: '2026-08-02', reason: 'again' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('LEAVE_OVERLAP');
    expect((await post(`/api/v1/staff-leaves/${first.body.id}/cancel`)).status).toBe(201);
    const replacement = await post('/api/v1/staff-leaves', { staffId, leaveType: 'UNPAID', fromDate: '2026-08-01', toDate: '2026-08-02', reason: 'rebooked' });
    expect(replacement.status).toBe(201);
  });
});
