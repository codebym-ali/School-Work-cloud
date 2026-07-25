import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { CLS_KEYS } from '@common';
import { PlatformPrismaService, TenantPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { admissionController } from './support/admission';
import { SmsService } from '../../apps/api/src/modules/comms/sms/sms.service';
import { SMS_QUEUE } from '../../apps/api/src/modules/comms/sms/sms.types';

/**
 * M3 gate (roadmap M3): mark attendance green + absence SMS verified.
 * Marks a student ABSENT, then drains the SMS queue through the real dispatch
 * pipeline and asserts a SENT ABSENCE SmsLog + a credit debit.
 */
describe('Attendance + absence SMS (e2e, §9/§14)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let cls: ClsService;
  let tenantPrisma: TenantPrismaService;
  let sms: SmsService;
  let schoolId: string;
  let cookies: string[];
  let csrf: string;
  let sectionId: string;
  let enrollmentId: string;

  const sub = `att-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const ownerEmail = 'owner@att.pk';
  const ownerPassword = 'Owner!Secret12';

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).send(b);
  const get = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

  const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const pastNonSunday = () => {
    for (let n = 4; n < 14; n++) if (new Date(daysAgo(n)).getUTCDay() !== 0) return daysAgo(n);
    return daysAgo(4);
  };
  const pastSunday = () => {
    for (let n = 1; n < 14; n++) if (new Date(daysAgo(n)).getUTCDay() === 0) return daysAgo(n);
    return daysAgo(7);
  };
  const absentDate = pastNonSunday();

  async function drainSms(): Promise<number> {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'prioritized']);
    for (const job of jobs) {
      await cls.run(async () => {
        cls.set(CLS_KEYS.schoolId, schoolId);
        await tenantPrisma.withTenant(() => sms.dispatch(job.data));
      });
      await job.remove();
    }
    return jobs.length;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    cls = app.get(ClsService);
    tenantPrisma = app.get(TenantPrismaService);
    sms = app.get(SmsService, { strict: false });

    const provisioning = app.get(ProvisioningService, { strict: false });
    const prov = await provisioning.provisionSchool({ name: 'Att School', subdomain: sub, ownerEmail, ownerPassword });
    schoolId = prov.schoolId;
    const campusId = prov.campusId;

    const login = await request(server()).post('/api/v1/auth/login').set('Host', host).send({ email: ownerEmail, password: ownerPassword });
    cookies = login.headers['set-cookie'] as unknown as string[];
    csrf = csrfOf(cookies);

    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    const klass = await post('/api/v1/classes', { campusId, name: 'Grade 1', order: 1 });
    const section = await post('/api/v1/sections', { classId: klass.body.id, name: 'A' });
    sectionId = section.body.id;

    // Students are created by the admission controller (§8), not the owner.
    const { admit } = await admissionController(app, platform, schoolId, host);
    const student = await admit({
      fullName: 'Sara Khan',
      gender: 'FEMALE',
      dateOfBirth: '2020-05-10',
      campusId,
      classId: klass.body.id,
      sectionId,
      guardian: { mode: 'CREATE', fullName: 'Ali Khan', phone: '03007654321', relation: 'FATHER' },
    });
    enrollmentId = student.body.enrollmentId;
    // Verify the guardian's phone so ABSENCE (which carries PII) may be sent (§14).
    await platform.parentProfile.updateMany({ where: { schoolId }, data: { phoneVerifiedAt: new Date() } });
  });

  afterAll(async () => {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    const tables = [
      'auditLog', 'smsLog', 'smsCreditLedger', 'smsTemplate', 'attendanceRecord', 'admission',
      'entryTest', 'studentGuardian', 'studentEnrollment', 'student', 'inquiry', 'parentProfile',
      'refreshToken', 'user', 'subject', 'section', 'class', 'academicYear', 'campus', 'school',
    ] as const;
    for (const t of tables) {
      const d = platform[t] as unknown as { deleteMany: (a: unknown) => Promise<unknown> };
      await d.deleteMany({ where: t === 'school' ? { id: schoolId } : { schoolId } }).catch(() => undefined);
    }
    await app.close();
  });

  it('rejects a future date (422)', async () => {
    const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const res = await post('/api/v1/attendance/bulk', {
      sectionId, date: future, session: 'MORNING', records: [{ enrollmentId, status: 'PRESENT' }],
    });
    expect(res.status).toBe(422);
  });

  it('rejects marking on a weekly-off (Sunday) without override (422)', async () => {
    const res = await post('/api/v1/attendance/bulk', {
      sectionId, date: pastSunday(), session: 'MORNING', records: [{ enrollmentId, status: 'PRESENT' }],
    });
    expect(res.status).toBe(422);
  });

  it('marks a student ABSENT (partial-failure contract) and queues an absence SMS', async () => {
    const res = await post('/api/v1/attendance/bulk', {
      sectionId, date: absentDate, session: 'MORNING', records: [{ enrollmentId, status: 'ABSENT' }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ succeeded: 1, failed: 0, absenceQueued: 1 });
  });

  it('dispatches the absence SMS: SENT log to the verified guardian + credit debit', async () => {
    const drained = await drainSms();
    expect(drained).toBeGreaterThanOrEqual(1);

    const logs = await platform.smsLog.findMany({ where: { schoolId, templateKey: 'ABSENCE' } });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('SENT');
    expect(logs[0].recipient).toBe('+923007654321');
    expect(logs[0].message).toContain('Sara Khan');

    const credits = await platform.smsCreditLedger.aggregate({ _sum: { delta: true }, where: { schoolId } });
    expect(credits._sum.delta).toBe(1000 - logs[0].segments); // BASIC grant minus this send
  });

  it('is idempotent: resubmitting the same ABSENT value queues no new absence', async () => {
    const res = await post('/api/v1/attendance/bulk', {
      sectionId, date: absentDate, session: 'MORNING', records: [{ enrollmentId, status: 'ABSENT' }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ succeeded: 1, absenceQueued: 0 });
  });

  it('lists attendance for the section and date', async () => {
    const res = await get(`/api/v1/attendance?sectionId=${sectionId}&date=${absentDate}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].status).toBe('ABSENT');
  });
});
