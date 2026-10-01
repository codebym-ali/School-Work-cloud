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
import { drainSmsFor } from './support/sms';
import * as argon2 from 'argon2';
import { loginRequest } from './support/login';
import { opsAdminSession } from './support/ops-admin';

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
  /** Campus admin — a CORRECTION role for student attendance. The owner is read-only (Owner UX plan 0.1),
   *  so every admin-powered mark in this spec (holiday override, beyond-window backfill) runs as this. */
  let adminCookies: string[];
  let ops: Awaited<ReturnType<typeof opsAdminSession>>;

  const sub = `att-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const ownerEmail = 'owner@att.pk';
  const ownerPassword = 'Owner!Secret12';

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).send(b);
  const get = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);
  const mark = (b: object) =>
    request(server()).post('/api/v1/attendance/bulk').set('Host', host).set('Cookie', adminCookies)
      .set('X-CSRF-Token', csrfOf(adminCookies)).send(b);

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

  const drainSms = () => drainSmsFor(app, schoolId);

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

    const login = await loginRequest(server(), host, ownerEmail, ownerPassword);
    cookies = login.headers['set-cookie'] as unknown as string[];
    csrf = csrfOf(cookies);

    ops = await opsAdminSession(app, platform, schoolId, host, 'ops@att.e2e.pk', campusId);
    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    const klass = await ops.post('/api/v1/classes', { campusId, name: 'Grade 1', order: 1 });
    const section = await ops.post('/api/v1/sections', { classId: klass.body.id, name: 'A' });
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

    const adminPassword = 'Campus!Secret12';
    await platform.user.create({
      data: {
        schoolId, campusId, email: 'campadmin@att.pk', roles: ['CAMPUS_ADMIN'] as never, status: 'ACTIVE',
        passwordHash: await argon2.hash(adminPassword, { type: argon2.argon2id }),
      },
    });
    adminCookies = (await loginRequest(server(), host, 'campadmin@att.pk', adminPassword)).headers['set-cookie'] as unknown as string[];
  });

  /** The backfill bound only applies to non-admins, so proving it needs a real teacher who is
   *  assigned to the section — an owner would bypass the very rule under test. */
  async function teacherSession(): Promise<string[]> {
    const email = `t-${randomUUID().slice(0, 8)}@att.pk`;
    const password = 'Teach!Secret12';
    const staff = (await ops.post('/api/v1/staff', {
      email, staffType: 'TEACHER', employeeCode: `EMP-${randomUUID().slice(0, 6)}`,
      designation: 'Teacher', joinedAt: '2026-04-01', campusId,
    })).body;
    await platform.user.update({
      where: { id: staff.userId },
      data: { status: 'ACTIVE', passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    const year = await platform.academicYear.findFirst({ where: { schoolId, isCurrent: true } });
    await ops.post('/api/v1/teacher-assignments', { staffId: staff.staffId, academicYearId: year!.id, sectionId });
    const res = await loginRequest(server(), host, email, password);
    return res.headers['set-cookie'] as unknown as string[];
  }

  afterAll(async () => {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  /**
   * G3 — which registers are still unmarked today.
   *
   * The rule that matters is **where the query starts**: from the SECTIONS, not from the
   * attendance table. A query over `attendance_records` can only ever return registers somebody
   * already filled in, so it returns the opposite of what is wanted. The staff register learned
   * this the hard way ("nobody said" is not "absent"); this is the student half.
   */
  describe('unmarked registers today', () => {
    const setMarkBy = (time: string) =>
      request(server()).patch('/api/v1/school-settings')
        .set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf)
        .send({ attendanceMarkByTime: time });

    afterAll(async () => { await setMarkBy('10:00'); });

    it("stays quiet before the school's own deadline, then names the section", async () => {
      // 23:59 — never reached during a run, so the deadline has not passed.
      await setMarkBy('23:59');
      const early = await get('/api/v1/attendance/unmarked-today');
      expect(early.status).toBe(200);
      expect(early.body.due).toBe(false);

      // 00:00 — always passed. The section exists and (on a fresh tenant) is unmarked, so it is
      // listed: the answer comes from the section list, not from rows that do not exist.
      await setMarkBy('00:00');
      const due = await get('/api/v1/attendance/unmarked-today');
      expect(due.body.due).toBe(true);
      expect(due.body.markByTime).toBe('00:00');
      // Either it is outstanding, or an earlier test in this file already marked it — both are
      // consistent, so assert the shape and the invariant rather than a brittle count.
      for (const row of due.body.sections) {
        expect(row.marked).toBeLessThan(row.expected);
        expect(row).toHaveProperty('className');
        expect(row).toHaveProperty('sectionName');
        expect(row).toHaveProperty('campusId'); // lets the screen narrow the list to the campus being viewed
      }
      expect(due.body.count).toBe(due.body.sections.length);
    });

    it('says the school is closed — not "all marked" — when every campus is off today', async () => {
      const setOff = (weeklyOffDays: string[]) =>
        request(server()).patch('/api/v1/school-settings')
          .set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf)
          .send({ weeklyOffDays });
      try {
        // All seven days, so the answer does not depend on which weekday the suite runs on.
        await setOff(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']);
        const closed = await get('/api/v1/attendance/unmarked-today');
        expect(closed.body.closed).toBe('Weekly off');
        // Nothing is "outstanding" on a closed day — the screen must be able to tell that from "all done".
        expect(closed.body.count).toBe(0);

        await setOff([]);
        const open = await get('/api/v1/attendance/unmarked-today');
        expect(open.body.closed).toBeNull();
      } finally {
        await setOff(['SUNDAY']);
      }
    });

    /**
     * G4 — the deadline is judged on the SCHOOL's clock, not the server's.
     *
     * Proves the wiring end to end (setting → service → response), not just the helper: the same
     * instant, the same `attendanceMarkByTime`, two time zones, two answers. Before this, every
     * tenant on the fleet was judged against whatever zone the server happened to run in, and it
     * would have failed silently — nothing in the response hints at which clock was used.
     */
    it("judges the deadline on the school's own clock, not the server's", async () => {
      const setTz = (timezone: string) =>
        request(server()).patch('/api/v1/school-settings')
          .set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf)
          .send({ timezone });

      /** The wall clock in a zone right now, "HH:MM" — the same comparison the product makes. */
      const hhmmIn = (timeZone: string) =>
        new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
          .format(new Date());

      /**
       * ⚠️ **The zones are ordered by their WALL CLOCK, not by their offset — and the earlier
       * version was wrong about that.** It assumed "Karachi is five hours ahead, so its local time
       * is later in the day", set the deadline just past UTC's clock, and expected UTC to be
       * not-due and Karachi due.
       *
       * That holds only until 19:00 UTC. After it, Karachi has rolled past midnight and reads
       * **00:xx — EARLIER in the day than UTC's 19:xx** — so the deadline had passed in UTC and
       * not in Karachi, the exact opposite, and the suite went red every evening for a reason that
       * had nothing to do with the product. *An offset is not an ordering once a date boundary sits
       * between the two.*
       *
       * The invariant under test is unchanged: with ONE deadline, the zone decides the answer. So
       * place the deadline between the two clocks, whichever way round they happen to be.
       */
      const zones = [
        { tz: 'UTC', at: hhmmIn('UTC') },
        { tz: 'Asia/Karachi', at: hhmmIn('Asia/Karachi') },
      ].sort((a, b) => a.at.localeCompare(b.at));
      const [earlier, later] = zones;

      // One minute past the earlier clock: not yet reached THERE, already behind in the later zone.
      const [h, m] = earlier.at.split(':').map(Number);
      const plusOne = new Date(Date.UTC(2000, 0, 1, h, m + 1));
      const markBy = `${String(plusOne.getUTCHours()).padStart(2, '0')}:${String(plusOne.getUTCMinutes()).padStart(2, '0')}`;

      // No room to place a boundary between them (same minute, or +1 wrapped past midnight).
      if (markBy === '00:00' || markBy > later.at) return;

      await setMarkBy(markBy);

      // The deadline sits just past the EARLIER clock, so it has not been reached there…
      await setTz(earlier.tz);
      expect((await get('/api/v1/attendance/unmarked-today')).body.due).toBe(false);

      // …and is already behind the later one. Same server, same instant, same setting — only the
      // school's zone differs.
      await setTz(later.tz);
      expect((await get('/api/v1/attendance/unmarked-today')).body.due).toBe(true);

      await setTz('Asia/Karachi');
    });

    it("is the head's view, not a teacher's", async () => {
      // A list of which colleagues are behind is oversight, not self-service. A teacher gets
      // their own coverage strip instead.
      const teacher = await teacherSession();
      const res = await request(server()).get('/api/v1/attendance/unmarked-today')
        .set('Host', host).set('Cookie', teacher);
      expect(res.status).toBe(403);
    });
  });

  /**
   * H2 — the closure notice the app shell shows on every page.
   *
   * The audience is the whole point: **teachers have no dashboard** (`/dashboard` is
   * owner/campus-admin/accountant only), so a notice hung on one would miss exactly the people
   * who need to know the gate is locked. This asserts a TEACHER can read it.
   */
  describe('closure notice (app shell)', () => {
    /**
     * ⚠️ **The SCHOOL's today, not the server's** — and reading it from the tenant's own setting
     * rather than hard-coding the zone, so this cannot drift if the fixture's timezone changes.
     *
     * This was `new Date().toISOString().slice(0, 10)`, the server's UTC date. `closureNotice()`
     * resolves "today" in the school's zone (correctly — that is the whole point of the deadline
     * test above), so after 19:00 UTC the tenant is already on the next day in Asia/Karachi and a
     * holiday created for the UTC date is *yesterday's*. The endpoint returned `closure: null` and
     * the failure read as "the closure notice is broken" when the test was the thing on the wrong
     * clock. **A test that asserts timezone correctness must not compute its own dates in UTC.**
     */
    let todayIso: string;
    beforeAll(async () => {
      const settings = await get('/api/v1/school-settings');
      const tz = (settings.body as { timezone?: string }).timezone ?? 'UTC';
      todayIso = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    });

    it('says nothing when the school is open', async () => {
      const res = await get('/api/v1/attendance/closure-notice');
      expect(res.status).toBe(200);
      expect(res.body.closure).toBeNull();
    });

    it('names the closure, and a TEACHER can see it', async () => {
      const closure = await post('/api/v1/holidays', { date: todayIso, name: 'Emergency closure' });
      expect(closure.status).toBe(201);
      try {
        const admin = await get('/api/v1/attendance/closure-notice');
        expect(admin.body.closure).toMatchObject({ name: 'Emergency closure', when: 'TODAY', date: todayIso });

        // The one that matters: a teacher has no dashboard, so if the shell could not read this
        // they would learn about the closure by arriving at a locked school.
        const teacher = await teacherSession();
        const asTeacher = await request(server()).get('/api/v1/attendance/closure-notice')
          .set('Host', host).set('Cookie', teacher);
        expect(asTeacher.status).toBe(200);
        expect(asTeacher.body.closure).toMatchObject({ name: 'Emergency closure', when: 'TODAY' });
      } finally {
        await request(server()).delete(`/api/v1/holidays/${closure.body.id}`)
          .set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf);
      }
    });

    it('stays quiet about a weekly off', async () => {
      // Everybody already knows the school is shut on Sunday. Announcing it every week is how a
      // notice becomes wallpaper and gets ignored on the day it actually matters.
      const res = await get('/api/v1/attendance/closure-notice');
      expect(res.body.closure).toBeNull();
    });
  });

  /**
   * H0 — declaring a closure must never destroy what a teacher observed.
   *
   * The emergency shape: the school opened, the register was taken, something happened at 10:30
   * and everyone went home. Declaring today closed stops FURTHER marking and takes the day out of
   * the payroll working-day count — it does not rewrite the morning, and it could not un-send the
   * absence SMS that already reached a parent anyway.
   */
  it('a closure declared for an already-marked day keeps the attendance', async () => {
    const day = recentWorkingDay(1);
    await mark({
      sectionId, date: day, session: 'MORNING', allowHolidayOverride: true,
      records: [{ enrollmentId, status: 'PRESENT' }],
    });
    // `GET /attendance` returns a plain array, not a paginated envelope.
    const before = await get(`/api/v1/attendance?sectionId=${sectionId}&date=${day}`);
    expect(before.body.length).toBeGreaterThan(0);

    const closure = await post('/api/v1/holidays', { date: day, name: 'Emergency closure' });
    expect(closure.status).toBe(201);

    // The rows survive, unchanged. This is the whole rule.
    const after = await get(`/api/v1/attendance?sectionId=${sectionId}&date=${day}`);
    expect(after.body.length).toBe(before.body.length);
    expect(after.body[0].status).toBe('PRESENT');

    // But the day is now closed, so marking it again needs the admin override — the same
    // treatment as a weekly off. A teacher gets the closed-day refusal.
    const blocked = await mark({ sectionId, date: day, session: 'MORNING', records: [{ enrollmentId, status: 'ABSENT' }] });
    expect(blocked.status).toBe(422);

    await request(server()).delete(`/api/v1/holidays/${closure.body.id}`)
      .set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf);
  });

  /**
   * Owner UX plan, Phase 0.1 — who may write a child's register. The class teacher marks; campus admin and
   * the Ops Admin correct; the OWNER only reads. An owner overwriting attendance (which texts parents and
   * becomes the child's record) blurs who is accountable for it.
   */
  describe('who may mark student attendance', () => {
    it('refuses the owner (403) — the owner view is read-only', async () => {
      const res = await post('/api/v1/attendance/bulk', {
        sectionId, date: todayStr, session: 'MORNING', records: [{ enrollmentId, status: 'PRESENT' }],
      });
      expect(res.status).toBe(403);
    });

    it('still lets the owner READ the register', async () => {
      expect((await get(`/api/v1/attendance?sectionId=${sectionId}&date=${todayStr}`)).status).toBe(200);
    });

    it('lets the Ops Admin (the deputy) correct it, with admin powers', async () => {
      // A far-past day: only an ADMIN may go beyond the teacher's backfill window — so this proves the
      // deputy is treated as an admin in the service, not merely admitted by the route gate.
      const res = await ops.post('/api/v1/attendance/bulk', { sectionId, date: daysAgo(21), session: 'MORNING', allowHolidayOverride: true, records: [{ enrollmentId, status: 'PRESENT' }] });
      expect(res.status).toBe(200);
      expect(res.body.succeeded).toBe(1);
    });
  });

  it('rejects a future date (422)', async () => {
    const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const res = await mark({
      sectionId, date: future, session: 'MORNING', records: [{ enrollmentId, status: 'PRESENT' }],
    });
    expect(res.status).toBe(422);
  });

  it('rejects marking on a weekly-off (Sunday) without override (422)', async () => {
    const res = await mark({
      sectionId, date: pastSunday(), session: 'MORNING', records: [{ enrollmentId, status: 'PRESENT' }],
    });
    expect(res.status).toBe(422);
  });

  it('marks a student ABSENT (partial-failure contract) and queues an absence SMS', async () => {
    const res = await mark({
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
    const res = await mark({
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

    const res = await mark({
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
    const admin = await mark({
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
    const res = await mark({
      sectionId, date: beforeJoining, session: 'MORNING', allowHolidayOverride: true,
      records: [{ enrollmentId, status: 'PRESENT' }],
    });
    expect(res.status).toBe(200); // partial-failure contract: the row fails, the request doesn't
    expect(res.body.succeeded).toBe(0);
    expect(res.body.failed).toBe(1);
    expect(res.body.errors[0].message).toContain('not enrolled');
  });
});
