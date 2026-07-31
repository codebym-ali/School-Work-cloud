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
import { destroyTenant } from './support/tenant';
import * as argon2 from 'argon2';

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
  let campusId: string;
  let enrollmentId: string;
  let studentId: string;

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
  /** The most recent working day at least `min` days back — skips the weekly off so the test
   *  exercises the backfill window rather than tripping the holiday rule. */
  const recentWorkingDay = (min: number) => {
    for (let n = min; n < 7; n++) if (new Date(daysAgo(n)).getUTCDay() !== 0) return daysAgo(n);
    return daysAgo(min);
  };
  const pastSunday = () => {
    for (let n = 1; n < 14; n++) if (new Date(daysAgo(n)).getUTCDay() === 0) return daysAgo(n);
    return daysAgo(7);
  };
  const absentDate = pastNonSunday();
  /** The absence SMS is only sent for TODAY (a week-late alert is accurate but useless), so the
   *  dispatch tests below mark today. `allowHolidayOverride` keeps them green if today is the
   *  weekly off — an admin may override, and the flag is ignored on a working day. */
  const todayStr = new Date().toISOString().slice(0, 10);

  /** The `sms` queue is shared across the whole Redis instance, so it can hold jobs from other
   *  tenants (a parallel spec, or a leftover from an interrupted run). Each job must therefore be
   *  dispatched under ITS OWN schoolId — forcing this spec's schoolId onto every job re-attributes
   *  another tenant's SMS to this school and breaks the log assertions below. Mirrors how the real
   *  worker resolves the tenant (`sms.processor.ts`). Jobs belonging to other schools are left alone.
   *  NOTE: a dev worker attached to the same Redis will race this and double-dispatch — stop
   *  `start:worker:dev` before running the integration suite. */
  async function drainSms(): Promise<number> {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'prioritized']);
    const mine = jobs.filter((j) => (j.data as { schoolId?: string })?.schoolId === schoolId);
    for (const job of mine) {
      await cls.run(async () => {
        cls.set(CLS_KEYS.schoolId, (job.data as { schoolId: string }).schoolId);
        await tenantPrisma.withTenant(() => sms.dispatch(job.data));
      });
      await job.remove();
    }
    return mine.length;
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
    campusId = prov.campusId;

    const login = await request(server()).post('/api/v1/auth/login').set('Host', host).send({ email: ownerEmail, password: ownerPassword });
    cookies = login.headers['set-cookie'] as unknown as string[];
    csrf = csrfOf(cookies);

    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    const klass = await post('/api/v1/classes', { campusId, name: 'Grade 1', order: 1 });
    const section = await post('/api/v1/sections', { classId: klass.body.id, name: 'A' });
    sectionId = section.body.id;

    // Students are created by the admission controller (§8), not the owner.
    const { admit } = await admissionController(app, platform, schoolId, host, campusId);
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
    studentId = student.body.studentId;
    // Verify the guardian's phone so ABSENCE (which carries PII) may be sent (§14).
    await platform.parentProfile.updateMany({ where: { schoolId }, data: { phoneVerifiedAt: new Date() } });
    // Backdate the enrolment. `startedAt` defaults to now(), and attendance may not be recorded
    // for a date before the student joined — without this, every backfill test would fail that
    // guard rather than the rule it means to exercise. A real student is enrolled long before
    // the days being marked.
    await platform.studentEnrollment.updateMany({
      where: { id: enrollmentId },
      data: { startedAt: new Date(Date.now() - 30 * 86400000) },
    });
  });

  /** The backfill bound only applies to non-admins, so proving it needs a real teacher who is
   *  assigned to the section — an owner would bypass the very rule under test. */
  async function teacherSession(): Promise<string[]> {
    const email = `t-${randomUUID().slice(0, 8)}@att.pk`;
    const password = 'Teach!Secret12';
    const staff = (await post('/api/v1/staff', {
      email, staffType: 'TEACHER', employeeCode: `EMP-${randomUUID().slice(0, 6)}`,
      designation: 'Teacher', joinedAt: '2026-04-01', campusId,
    })).body;
    await platform.user.update({
      where: { id: staff.userId },
      data: { status: 'ACTIVE', passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    const year = await platform.academicYear.findFirst({ where: { schoolId, isCurrent: true } });
    await post('/api/v1/teacher-assignments', { staffId: staff.staffId, academicYearId: year!.id, sectionId });
    const res = await request(server()).post('/api/v1/auth/login').set('Host', host).send({ email, password });
    return res.headers['set-cookie'] as unknown as string[];
  }

  afterAll(async () => {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    await destroyTenant(platform, schoolId);
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
      sectionId, date: todayStr, session: 'MORNING', allowHolidayOverride: true,
      records: [{ enrollmentId, status: 'ABSENT' }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ succeeded: 1, failed: 0, absenceQueued: 1, absenceNotifiedSuppressed: 0 });
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

  /** A redelivered job (BullMQ retry, or a stalled worker being recovered) must not send the
   *  guardian a second message or debit credits twice — the dedupe key claims the event. */
  it('re-dispatching the same absence job sends nothing and debits nothing (idempotent)', async () => {
    const before = await platform.smsCreditLedger.aggregate({ _sum: { delta: true }, where: { schoolId } });

    await cls.run(async () => {
      cls.set(CLS_KEYS.schoolId, schoolId);
      await tenantPrisma.withTenant(() =>
        sms.dispatch({ type: 'ABSENCE', schoolId, enrollmentId, studentId, date: todayStr }),
      );
    });

    const logs = await platform.smsLog.findMany({ where: { schoolId, templateKey: 'ABSENCE' } });
    expect(logs).toHaveLength(1); // still one — the duplicate was dropped
    const after = await platform.smsCreditLedger.aggregate({ _sum: { delta: true }, where: { schoolId } });
    expect(after._sum.delta).toBe(before._sum.delta);
  });

  it('is idempotent: resubmitting the same ABSENT value queues no new absence', async () => {
    const res = await post('/api/v1/attendance/bulk', {
      sectionId, date: todayStr, session: 'MORNING', allowHolidayOverride: true,
      records: [{ enrollmentId, status: 'ABSENT' }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ succeeded: 1, absenceQueued: 0 });
  });

  it('lists attendance for the section and date', async () => {
    const res = await get(`/api/v1/attendance?sectionId=${sectionId}&date=${todayStr}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].status).toBe('ABSENT');
  });

  /** Backfill (2026-07-30). Marking a day that was missed is legitimate; ANNOUNCING it a week
   *  later is not — the alert exists so a parent can act the same day, and a week's backfill for
   *  one section would burst 30+ texts about days everyone already knows about. */
  it('records a backdated absence but does NOT text the guardian', async () => {
    const logsBefore = await platform.smsLog.count({ where: { schoolId, templateKey: 'ABSENCE' } });

    const res = await post('/api/v1/attendance/bulk', {
      sectionId, date: absentDate, session: 'MORNING', records: [{ enrollmentId, status: 'ABSENT' }],
    });
    expect(res.status).toBe(200);
    // The record IS written — only the notification is withheld.
    expect(res.body).toMatchObject({ succeeded: 1, failed: 0, absenceQueued: 0, absenceNotifiedSuppressed: 1 });

    const stored = await get(`/api/v1/attendance?sectionId=${sectionId}&date=${absentDate}`);
    expect(stored.body[0].status).toBe('ABSENT');

    // Nothing was queued, so draining cannot produce a new log.
    await drainSms();
    expect(await platform.smsLog.count({ where: { schoolId, templateKey: 'ABSENCE' } })).toBe(logsBefore);
  });

  it('lets a teacher fill in a missed day, but not rewrite history beyond the window', async () => {
    const tc = await teacherSession();
    const asTeacher = (date: string) =>
      request(server()).post('/api/v1/attendance/bulk')
        .set('Host', host).set('Cookie', tc).set('X-CSRF-Token', csrfOf(tc))
        .send({ sectionId, date, session: 'MORNING', allowHolidayOverride: false, records: [{ enrollmentId, status: 'PRESENT' }] });

    // Inside the 7-day window: allowed (this is the feature).
    const within = await asTeacher(recentWorkingDay(2));
    expect(within.status).toBe(200);
    expect(within.body.succeeded).toBe(1);

    // Beyond it: refused, and the message says who can do it instead.
    const beyond = await asTeacher(daysAgo(20));
    expect(beyond.status).toBe(422);
    expect(beyond.body.error.message).toContain('days back');

    // The same far-past date is accepted for an ADMIN — the bound is a teacher rule, not a
    // school-wide freeze, so corrections remain possible with oversight.
    const admin = await post('/api/v1/attendance/bulk', {
      sectionId, date: daysAgo(20), session: 'MORNING', allowHolidayOverride: true,
      records: [{ enrollmentId, status: 'PRESENT' }],
    });
    expect(admin.status).toBe(200);
    expect(admin.body.succeeded).toBe(1);
  });

  /** The strip is what makes backfill usable — it must tell the truth about which days are
   *  gaps, and must never present a weekly off as one. */
  it('reports 7-day coverage: marked days, gaps, and non-working days', async () => {
    const res = await get(`/api/v1/attendance/coverage?sectionId=${sectionId}&session=MORNING&days=7`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(7);

    const byDate: Record<string, { working: boolean; marked: number; expected: number }> =
      Object.fromEntries(res.body.map((d: { date: string }) => [d.date, d]));

    // Today was marked earlier in this spec, so it reads as covered.
    expect(byDate[todayStr].marked).toBeGreaterThanOrEqual(1);

    // Sunday is returned as non-working rather than as a missing day — a strip that flags every
    // weekend is a strip nobody reads.
    const sunday = res.body.find((d: { date: string }) => new Date(`${d.date}T00:00:00Z`).getUTCDay() === 0);
    if (sunday) {
      expect(sunday.working).toBe(false);
      expect(sunday.expected).toBe(0);
    }

    // A working day nobody has touched is a real gap.
    const untouched = res.body.find(
      (d: { date: string; working: boolean; marked: number }) =>
        d.working && d.marked === 0 && d.date !== todayStr && d.date !== absentDate,
    );
    if (untouched) expect(untouched.expected).toBeGreaterThan(0);
  });

  it('refuses attendance for a date before the student was enrolled', async () => {
    // The enrolment was created during setup (today), so any earlier date predates it. Without
    // this guard, backfilling invents a record of a child who had not joined the school.
    const beforeJoining = daysAgo(40); // enrolment starts 30 days ago (see beforeAll)
    const res = await post('/api/v1/attendance/bulk', {
      sectionId, date: beforeJoining, session: 'MORNING', allowHolidayOverride: true,
      records: [{ enrollmentId, status: 'PRESENT' }],
    });
    expect(res.status).toBe(200); // partial-failure contract: the row fails, the request doesn't
    expect(res.body.succeeded).toBe(0);
    expect(res.body.failed).toBe(1);
    expect(res.body.errors[0].message).toContain('not enrolled');
  });
});
