import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { destroyTenant } from './support/tenant';

/**
 * Staff attendance marking (§9/§13).
 *
 * `POST /staff-attendance/bulk` previously validated NOTHING — any date including the future,
 * any staff member in any campus, no working-day check, no audit — while returning the
 * partial-failure shape (§25.3) it never populated. These rows feed `payroll.absentDays()`
 * straight into the salary deduction, so each of those was a way to move somebody's pay.
 */
describe('Staff attendance marking (e2e)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;

  let campusA: string;
  let campusB: string;
  let ownerCookies: string[];
  let ownerCsrf: string;
  let adminCookies: string[]; // CAMPUS_ADMIN bound to campus A
  let adminCsrf: string;
  let ownerUserId: string;

  let staffA: string; // campus A, joined long ago
  let staffB: string; // campus B
  let newJoiner: string; // campus A, joins today

  const sub = `sat-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@sat.pk', password: 'Owner!Secret12' };
  const admin = { email: 'campadmin@sat.pk', password: 'Admin!Secret12' };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const authed = (method: 'get' | 'post', p: string, cookies: string[], csrf?: string) => {
    let r = request(server())[method](p).set('Host', host).set('Cookie', cookies);
    if (csrf) r = r.set('X-CSRF-Token', csrf);
    return r;
  };
  const ownerPost = (p: string, b: object = {}) => authed('post', p, ownerCookies, ownerCsrf).send(b);
  const login = async (e: string, pw: string) => {
    const res = await request(server()).post('/api/v1/auth/login').set('Host', host).send({ email: e, password: pw });
    return res.headers['set-cookie'] as unknown as string[];
  };

  /** A recent working day (the school's default weekly-off is SUNDAY). */
  const workingDay = (): string => {
    const d = new Date();
    while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const mark = (staffId: string, status: string, date = workingDay(), extra: object = {}) =>
    ownerPost('/api/v1/staff-attendance/bulk', { date, session: 'MORNING', records: [{ staffId, status }], ...extra });

  async function createStaff(email: string, campusId: string, joinedAt: string): Promise<string> {
    const res = await ownerPost('/api/v1/staff', {
      email, campusId, staffType: 'TEACHER', employeeCode: `EMP-${randomUUID().slice(0, 6)}`,
      designation: 'Teacher', joinedAt, fullName: `T ${email.split('@')[0]}`,
    });
    expect(res.status).toBe(201);
    return res.body.staffId;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const provisioning = app.get(ProvisioningService, { strict: false });
    const prov = await provisioning.provisionSchool({
      name: 'Staff Att School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password,
    });
    schoolId = prov.schoolId;
    campusA = prov.campusId;

    ownerCookies = await login(owner.email, owner.password);
    ownerCsrf = csrfOf(ownerCookies);
    ownerUserId = (await platform.user.findFirstOrThrow({ where: { schoolId, email: owner.email } })).id;

    await ownerPost('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    campusB = (await ownerPost('/api/v1/campuses', { name: 'Campus B' })).body.id;

    const longAgo = iso(new Date(Date.now() - 400 * 86400000));
    staffA = await createStaff('sa@sat.pk', campusA, longAgo);
    staffB = await createStaff('sb@sat.pk', campusB, longAgo);
    newJoiner = await createStaff('nj@sat.pk', campusA, iso(new Date()));

    await platform.user.create({
      data: {
        schoolId, campusId: campusA, email: admin.email, roles: ['CAMPUS_ADMIN'] as never, status: 'ACTIVE',
        passwordHash: await argon2.hash(admin.password, { type: argon2.argon2id }),
      },
    });
    adminCookies = await login(admin.email, admin.password);
    adminCsrf = csrfOf(adminCookies);
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  afterEach(async () => {
    await platform.staffAttendance.deleteMany({ where: { schoolId } });
    // Payslips before runs: the FK is RESTRICT, so deleting the run first throws — and a
    // throwing afterEach leaves the NEXT test running against dirty state, which is how one
    // broken cleanup reads as two unrelated failures.
    await platform.payslip.deleteMany({ where: { schoolId } });
    await platform.payrollRun.deleteMany({ where: { schoolId } });
  });

  it('records attendance with provenance — who marked it, and how', async () => {
    const res = await mark(staffA, 'PRESENT');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ succeeded: 1, failed: 0 });

    const row = await platform.staffAttendance.findFirstOrThrow({ where: { staffId: staffA } });
    // Provenance is the whole point: these rows move salaries, so "who says so" must survive.
    expect(row.source).toBe('ADMIN');
    expect(row.markedById).toBe(ownerUserId);
  });

  it('refuses a future date outright', async () => {
    const tomorrow = iso(new Date(Date.now() + 86400000));
    const res = await mark(staffA, 'PRESENT', tomorrow);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('a campus admin cannot mark another campus’s staff, and the good rows still land', async () => {
    // The live gap: this was accepted outright. Sent alongside a legitimate row, because the
    // partial-failure contract is the other half of the fix — one bad id must not reject a
    // register the office just typed.
    const res = await authed('post', '/api/v1/staff-attendance/bulk', adminCookies, adminCsrf).send({
      date: workingDay(), session: 'MORNING',
      records: [{ staffId: staffA, status: 'PRESENT' }, { staffId: staffB, status: 'PRESENT' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.succeeded).toBe(1);
    expect(res.body.failed).toBe(1);
    expect(res.body.errors[0]).toMatchObject({ index: 1, code: 'FORBIDDEN' });

    expect(await platform.staffAttendance.count({ where: { staffId: staffB } })).toBe(0);
    expect(await platform.staffAttendance.count({ where: { staffId: staffA } })).toBe(1);
  });

  it('refuses to mark someone on a date before they were employed', async () => {
    // Same rule the student register applies to enrolments: a backdated write must ask
    // "was this true THEN", not "is it true now".
    const lastWeek = iso(new Date(Date.now() - 7 * 86400000));
    const res = await mark(newJoiner, 'ABSENT', lastWeek);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ succeeded: 0, failed: 1 });
    expect(res.body.errors[0].message).toMatch(/Not employed/);
  });

  it('refuses a weekly-off day unless the override is passed', async () => {
    const sunday = new Date();
    while (sunday.getUTCDay() !== 0) sunday.setUTCDate(sunday.getUTCDate() - 1);

    const refused = await mark(staffA, 'PRESENT', iso(sunday));
    expect(refused.body).toMatchObject({ succeeded: 0, failed: 1 });
    expect(refused.body.errors[0].message).toMatch(/Holiday or weekly-off/);

    const forced = await mark(staffA, 'PRESENT', iso(sunday), { allowHolidayOverride: true });
    expect(forced.body).toMatchObject({ succeeded: 1, failed: 0 });
  });

  it('is idempotent on resubmit and updates on a real change', async () => {
    await mark(staffA, 'PRESENT');
    const again = await mark(staffA, 'PRESENT');
    expect(again.body).toMatchObject({ succeeded: 1, failed: 0 });
    expect(await platform.staffAttendance.count({ where: { staffId: staffA } })).toBe(1);

    await mark(staffA, 'ABSENT');
    const row = await platform.staffAttendance.findFirstOrThrow({ where: { staffId: staffA } });
    expect(row.status).toBe('ABSENT');
  });

  it('audits overriding a self-marked day, preserving what the staff member claimed', async () => {
    // Seeded directly: self check-in is S2. The override rule is what S1 owes it — an admin
    // replacing somebody's own claim about themselves changes their pay.
    const checkIn = new Date();
    await platform.staffAttendance.create({
      data: {
        schoolId, staffId: staffA, date: new Date(workingDay()), session: 'MORNING',
        status: 'PRESENT', source: 'SELF', checkIn,
      },
    });

    const res = await mark(staffA, 'ABSENT', workingDay(), { note: 'Not on site' });
    expect(res.body).toMatchObject({ succeeded: 1, failed: 0 });

    const audit = await platform.auditLog.findFirst({
      where: { schoolId, action: 'STAFF_ATTENDANCE_OVERRIDDEN' },
    });
    expect(audit).not.toBeNull();
    // The row now says ABSENT/ADMIN, so only the audit entry remembers the original claim.
    expect(audit!.oldValue).toMatchObject({ status: 'PRESENT', source: 'SELF' });
    expect(audit!.userId).toBe(ownerUserId);
  });

  it('does NOT audit an ordinary admin correction of an admin-marked day', async () => {
    // Auditing every keystroke buries the entries that matter — the same reason renames are
    // deliberately not audited.
    //
    // Measured as a DELTA, not an absolute count: `afterEach` clears attendance but audit rows
    // must outlive what they describe, so the override case above leaves one behind. Asserting
    // `toBe(0)` here passes or fails on test ORDER, which is not the property under test.
    const before = await platform.auditLog.count({ where: { schoolId, action: 'STAFF_ATTENDANCE_OVERRIDDEN' } });
    await mark(staffA, 'PRESENT');
    await mark(staffA, 'ABSENT');
    const after = await platform.auditLog.count({ where: { schoolId, action: 'STAFF_ATTENDANCE_OVERRIDDEN' } });
    expect(after).toBe(before);
  });

  /**
   * G5 — reaching back into a month that has already closed.
   *
   * There is deliberately **no backfill floor** on staff attendance: schools genuinely correct
   * last month's register, and blocking that would be worse than the risk. The hole was never
   * the time limit — it was the SILENCE. An admin changing another admin's row from months ago
   * left no trace at all, and staff attendance feeds payroll.
   */
  describe('backdated edits (G5)', () => {
    /** A working day in the previous month — the month the office has already worked through. */
    const lastMonthDay = () => {
      const d = new Date();
      d.setUTCDate(1);
      d.setUTCDate(0); // last day of the previous month
      while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() - 1); // skip the weekly off
      return d.toISOString().slice(0, 10);
    };

    it('audits an admin editing an admin-marked row in a closed month', async () => {
      const day = lastMonthDay();
      const before = await platform.auditLog.count({ where: { schoolId, action: 'STAFF_ATTENDANCE_BACKDATED' } });

      // Both writes are by the owner, so the OVERRIDDEN rule (which only fires over a SELF or
      // SYSTEM row) does not apply — this is precisely the case that used to vanish.
      await mark(staffA, 'PRESENT', day);
      const res = await mark(staffA, 'ABSENT', day, { note: 'Was actually away' });
      expect(res.body).toMatchObject({ succeeded: 1, failed: 0 });

      const after = await platform.auditLog.count({ where: { schoolId, action: 'STAFF_ATTENDANCE_BACKDATED' } });
      expect(after).toBe(before + 1);

      const row = await platform.auditLog.findFirst({
        where: { schoolId, action: 'STAFF_ATTENDANCE_BACKDATED' },
        orderBy: { createdAt: 'desc' },
      });
      expect(row!.oldValue).toMatchObject({ status: 'PRESENT' });
      expect(row!.newValue).toMatchObject({ status: 'ABSENT', backdated: true });
      expect(row!.reason).toBe('Was actually away');
    });

    it('does not audit an ordinary correction inside the current month', async () => {
      // The signal only means something if the current month stays quiet — otherwise the log
      // fills with routine register-keeping and the backdated entries are buried in it.
      const before = await platform.auditLog.count({ where: { schoolId, action: 'STAFF_ATTENDANCE_BACKDATED' } });
      await mark(staffA, 'PRESENT');
      await mark(staffA, 'ABSENT');
      const after = await platform.auditLog.count({ where: { schoolId, action: 'STAFF_ATTENDANCE_BACKDATED' } });
      expect(after).toBe(before);
    });
  });

  // ── Self check-in (S2) ─────────────────────────────────────────────────────
  describe('self check-in', () => {
    /** A real, signed-in teacher — the rules under test only apply to a non-admin. */
    let teacherCookies: string[];
    let teacherCsrf: string;
    let teacherStaffId: string;
    const teacherPw = 'Teach!Secret12';

    const setSelfMarking = (on: boolean, extra: object = {}) =>
      platform.school.update({
        where: { id: schoolId },
        data: { settings: { staffAttendance: { selfMarking: on, ...extra } } },
      });

    beforeAll(async () => {
      teacherStaffId = await createStaff('selfmark@sat.pk', campusA, iso(new Date(Date.now() - 400 * 86400000)));
      const staff = await platform.staffProfile.findFirstOrThrow({ where: { id: teacherStaffId } });
      await platform.user.update({
        where: { id: staff.userId! },
        data: { status: 'ACTIVE', passwordHash: await argon2.hash(teacherPw, { type: argon2.argon2id }) },
      });
      teacherCookies = await login('selfmark@sat.pk', teacherPw);
      teacherCsrf = csrfOf(teacherCookies);
    });

    afterEach(async () => { await setSelfMarking(false); });

    const checkIn = () => authed('post', '/api/v1/staff-attendance/check-in', teacherCookies, teacherCsrf).send({});

    it('is refused while the school has self-marking switched off', async () => {
      await setSelfMarking(false);
      const res = await checkIn();
      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/switched off/i);
    });

    it('records PRESENT or LATE from the CLOCK, with SELF provenance and a timestamp', async () => {
      await setSelfMarking(true);
      const res = await checkIn();
      if (res.status === 422) return; // today is a weekly off — covered by its own case below
      expect(res.status).toBe(201);

      const row = await platform.staffAttendance.findFirstOrThrow({ where: { staffId: teacherStaffId } });
      expect(row.source).toBe('SELF');
      expect(row.checkIn).not.toBeNull();
      // The teacher never said which of these it is — the server decided from the clock.
      expect(['PRESENT', 'LATE']).toContain(row.status);
    });

    it('cannot be pressed twice — the second attempt does not overwrite the first timestamp', async () => {
      await setSelfMarking(true);
      const first = await checkIn();
      if (first.status === 422) return;
      const firstRow = await platform.staffAttendance.findFirstOrThrow({ where: { staffId: teacherStaffId } });

      const second = await checkIn();
      expect(second.status).toBe(409);
      const afterRow = await platform.staffAttendance.findFirstOrThrow({ where: { staffId: teacherStaffId } });
      expect(afterRow.checkIn).toEqual(firstRow.checkIn);
    });

    it('cannot resurrect a day the office already marked ABSENT', async () => {
      // The exploit this endpoint exists to not have: pressing a button to undo a deduction.
      await setSelfMarking(true);
      await mark(teacherStaffId, 'ABSENT');
      const res = await checkIn();
      expect(res.status).toBe(409);
      const row = await platform.staffAttendance.findFirstOrThrow({ where: { staffId: teacherStaffId } });
      expect(row.status).toBe('ABSENT');
      expect(row.source).toBe('ADMIN');
    });

    it('ignores a smuggled staffId, status and date — the handler reads no body at all', async () => {
      await setSelfMarking(true);
      const res = await authed('post', '/api/v1/staff-attendance/check-in', teacherCookies, teacherCsrf)
        .send({ staffId: staffB, status: 'PRESENT', date: '2020-01-01' });
      if (res.status === 422) return; // weekly off

      // The handler declares no @Body(), so these fields are not validated away — they are
      // never read. That is the stronger property: marking a colleague, backdating, or picking
      // your own status are not permissions that could be misconfigured, they are unexpressible.
      expect(res.status).toBe(201);
      expect(await platform.staffAttendance.count({ where: { staffId: staffB } })).toBe(0);

      const mine = await platform.staffAttendance.findFirstOrThrow({ where: { staffId: teacherStaffId } });
      expect(mine.date.toISOString().slice(0, 10)).not.toBe('2020-01-01');
      expect(mine.source).toBe('SELF');
    });

    it('a teacher still cannot mark anyone via the admin endpoint', async () => {
      await setSelfMarking(true);
      const res = await authed('post', '/api/v1/staff-attendance/bulk', teacherCookies, teacherCsrf)
        .send({ date: workingDay(), session: 'MORNING', records: [{ staffId: teacherStaffId, status: 'PRESENT' }] });
      expect(res.status).toBe(403);
    });

    it('reports what the button would do before it is pressed', async () => {
      await setSelfMarking(true);
      const res = await authed('get', '/api/v1/staff-attendance/mine/check-in', teacherCookies);
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      // Stated in advance so "you're late" is never sprung after the click.
      expect(['PRESENT', 'LATE']).toContain(res.body.wouldBe);
    });
  });

  // ── Own history (S2) ───────────────────────────────────────────────────────
  describe('GET /staff-attendance/mine', () => {
    let cookies: string[];

    beforeAll(async () => {
      const staff = await platform.staffProfile.findFirstOrThrow({ where: { id: staffA } });
      await platform.user.update({
        where: { id: staff.userId! },
        data: { status: 'ACTIVE', passwordHash: await argon2.hash('Range!Secret12', { type: argon2.argon2id }) },
      });
      cookies = await login('sa@sat.pk', 'Range!Secret12');
    });

    it('filters by range and counts unmarked working days separately from absences', async () => {
      const day = workingDay();
      await mark(staffA, 'ABSENT', day);

      const rows = await authed('get', `/api/v1/staff-attendance/mine?from=${day}&to=${day}`, cookies);
      expect(rows.status).toBe(200);
      expect(rows.body).toHaveLength(1);

      const summary = await authed('get', `/api/v1/staff-attendance/mine/summary?from=${day}&to=${day}`, cookies);
      expect(summary.body).toMatchObject({ absent: 1, marked: 1, workingDays: 1, unmarked: 0, percent: 0 });

      // A range the person was employed for but nobody marked: unmarked, NOT absent. Folding
      // one into the other is how a half-kept register turns into a salary deduction.
      const earlier = iso(new Date(new Date(day).getTime() - 30 * 86400000));
      const gap = await authed('get', `/api/v1/staff-attendance/mine/summary?from=${earlier}&to=${earlier}`, cookies);
      expect(gap.body.absent).toBe(0);
      expect(gap.body.unmarked).toBeGreaterThanOrEqual(0);
      expect(gap.body.percent).toBeNull();
    });

    it('rejects an inverted range', async () => {
      const res = await authed('get', '/api/v1/staff-attendance/mine?from=2026-08-10&to=2026-08-01', cookies);
      expect(res.status).toBe(422);
    });

    it('403s an account with no staff profile — the owner has no own attendance to read', async () => {
      // Authorization is resolved before the query, so this is a 403 and not an empty list:
      // "you have no staff record" and "you were never marked" are different answers.
      const res = await authed('get', '/api/v1/staff-attendance/mine', ownerCookies);
      expect(res.status).toBe(403);
    });
  });

  // ── Oversight (S3) ─────────────────────────────────────────────────────────
  describe('owner oversight', () => {
    it('counts unmarked staff separately from absent ones', async () => {
      const day = workingDay();
      await mark(staffA, 'ABSENT', day);

      const res = await authed('get', `/api/v1/staff-attendance/summary?date=${day}`, ownerCookies);
      expect(res.status).toBe(200);
      // Asserted as a RELATIONSHIP, not a headcount — other blocks in this spec add staff, and
      // a hard number would make this test about fixture order rather than about the rule.
      //
      // The rule: exactly one person is recorded absent, and everyone else is UNMARKED, not
      // absent. Reporting "1 absent" while silently treating the rest as fine would present a
      // half-kept register as fact — which is why the day-close job was deferred, not assumed.
      const { totalStaff, absent, unmarked, workingDay: isWorking } = res.body;
      expect(isWorking).toBe(true);
      expect(absent).toBe(1);
      expect(unmarked).toBe(totalStaff - 1);
      expect(totalStaff).toBeGreaterThan(1);
    });

    it('the register lists people nobody marked, and UNMARKED is filterable', async () => {
      const day = workingDay();
      await mark(staffA, 'PRESENT', day);

      const all = await authed('get', `/api/v1/staff-attendance?date=${day}`, ownerCookies);
      // A query over staff_attendance alone could never return these rows — the register has
      // to start from the staff LIST, or the people worth chasing are exactly the ones it omits.
      const marked = all.body.filter((r: { status: string | null }) => r.status !== null);
      const blank = all.body.filter((r: { status: string | null }) => r.status === null);
      expect(marked).toHaveLength(1);
      expect(blank.length).toBe(all.body.length - 1);

      const gaps = await authed('get', `/api/v1/staff-attendance?date=${day}&status=UNMARKED`, ownerCookies);
      expect(gaps.body).toHaveLength(blank.length);
      expect(gaps.body.every((r: { status: string | null }) => r.status === null)).toBe(true);
    });

    it('a campus admin sees only their own campus, and cannot ask for another', async () => {
      const day = workingDay();
      const own = await authed('get', `/api/v1/staff-attendance?date=${day}`, adminCookies);
      expect(own.body.every((r: { staffId: string }) => r.staffId !== staffB)).toBe(true);

      // A client-supplied campusId for someone else's campus is IGNORED, not honoured (P1.7).
      const forced = await authed('get', `/api/v1/staff-attendance?date=${day}&campusId=${campusB}`, adminCookies);
      expect(forced.status).toBe(200);
      expect(forced.body.every((r: { staffId: string }) => r.staffId !== staffB)).toBe(true);
    });

    it('one staff member’s history defaults to their whole employment, not an invented window', async () => {
      const day = workingDay();
      await mark(staffA, 'ABSENT', day);

      const res = await authed('get', `/api/v1/staff-attendance/staff/${staffA}`, ownerCookies);
      expect(res.status).toBe(200);
      expect(res.body.staff).toMatchObject({ id: staffA });
      // No `from` ⇒ from the joining date, so a lifetime question gets a lifetime answer.
      expect(res.body.from).toBe(res.body.staff.joinedAt);
      expect(res.body.absent).toBe(1);
      expect(res.body.rows).toHaveLength(1);
    });

    it('a campus admin cannot read another campus’s staff history', async () => {
      const res = await authed('get', `/api/v1/staff-attendance/staff/${staffB}`, adminCookies);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('says plainly when the day is not a working one', async () => {
      const sunday = new Date();
      while (sunday.getUTCDay() !== 0) sunday.setUTCDate(sunday.getUTCDate() - 1);
      const res = await authed('get', `/api/v1/staff-attendance/summary?date=${iso(sunday)}`, ownerCookies);
      // Otherwise a Sunday reads as every member of staff being absent.
      expect(res.body.workingDay).toBe(false);
      expect(res.body.absent).toBe(0);
    });
  });

  it('deducts the same whether the office typed the absence or the day-close job derived it', async () => {
    // The two sources must not disagree. Nothing in payroll looks at `source` today, and this
    // asserts it stays that way — otherwise enabling the day-close job would quietly change
    // everyone's pay, which is the failure that keeps a school from trusting the register.
    const day = workingDay();
    const d = new Date(day);
    const joined = iso(new Date(Date.now() - 400 * 86400000));

    const typed = await createStaff('paytyped@sat.pk', campusA, joined);
    const derived = await createStaff('payderived@sat.pk', campusA, joined);
    for (const id of [typed, derived]) {
      const res = await ownerPost(`/api/v1/staff/${id}/salary-structures`, { basic: 30000, effectiveFrom: joined });
      expect(res.status).toBe(201);
    }

    await mark(typed, 'ABSENT', day); // through the admin endpoint → source ADMIN
    await platform.staffAttendance.create({ // as the day-close job writes it
      data: { schoolId, staffId: derived, date: d, session: 'MORNING', status: 'ABSENT', source: 'SYSTEM' },
    });

    const run = await ownerPost('/api/v1/payroll-runs', { campusId: campusA, month: d.getUTCMonth() + 1, year: d.getUTCFullYear() });
    expect(run.status).toBe(201);

    const detail = await authed('get', `/api/v1/payroll-runs/${run.body.runId}`, ownerCookies);
    const slips = detail.body.payslips as { staffId: string; netPay: string; deductions: unknown }[];
    const a = slips.find((s) => s.staffId === typed);
    const b = slips.find((s) => s.staffId === derived);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(Number(b!.netPay)).toBe(Number(a!.netPay));
    // And the absence actually cost something — otherwise the equality above is vacuous.
    expect(Number(a!.netPay)).toBeLessThan(30000);
  });

  it('freezes the approved campus for that month — and ONLY that campus', async () => {
    const day = workingDay();
    const d = new Date(day);
    // PayrollRun is unique on [school, campus, month, year] — one run per campus. Approving
    // campus A must not take campus B's register away for the rest of the month, which a
    // campus-blind lock did. Sent as ONE request spanning both campuses, because that is the
    // shape that made the original defect invisible: a single-campus fixture cannot tell a
    // scoped guard from an unscoped one.
    await platform.payrollRun.create({
      data: {
        schoolId, campusId: campusA, month: d.getUTCMonth() + 1, year: d.getUTCFullYear(),
        status: 'APPROVED', createdById: ownerUserId,
      },
    });

    const res = await ownerPost('/api/v1/staff-attendance/bulk', {
      date: day, session: 'MORNING',
      records: [{ staffId: staffA, status: 'ABSENT' }, { staffId: staffB, status: 'ABSENT' }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ succeeded: 1, failed: 1 });
    expect(res.body.errors[0]).toMatchObject({ index: 0, code: 'CONFLICT' });
    expect(res.body.errors[0].message).toMatch(/reverse the payroll run/i);

    // A payslip was computed from campus A's rows, so they hold still...
    expect(await platform.staffAttendance.count({ where: { staffId: staffA } })).toBe(0);
    // ...while campus B, whose pay is not settled, carries on working.
    expect(await platform.staffAttendance.count({ where: { staffId: staffB } })).toBe(1);
  });
});
