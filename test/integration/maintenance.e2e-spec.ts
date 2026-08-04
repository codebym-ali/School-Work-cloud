import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import { CommonModule } from '@common';
import { DatabaseModule, PlatformPrismaService } from '@database';
import { FeeJobsService } from '../../apps/api/src/modules/fees/fee-jobs.service';
import { MaintenanceService } from '../../apps/worker/src/maintenance/maintenance.service';
import { destroyTenant } from './support/tenant';

/**
 * Cross-tenant nightly maintenance runner (blueprint §27). Verifies the runner iterates
 * EVERY active tenant (each in its own CLS + withTenant context) and runs the fee jobs
 * without error — the per-tenant fee logic itself is covered by the fees e2e. Suspended
 * tenants are skipped.
 */
describe('Maintenance runner (e2e, §27)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let maintenance: MaintenanceService;

  const schoolA = randomUUID();
  const schoolB = randomUUID();
  const suspended = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true }), CommonModule, DatabaseModule],
      providers: [MaintenanceService, FeeJobsService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    platform = app.get(PlatformPrismaService);
    maintenance = app.get(MaintenanceService);

    await platform.school.create({ data: { id: schoolA, name: 'Maint A', subdomain: `mnt-${schoolA.slice(0, 8)}` } });
    await platform.school.create({ data: { id: schoolB, name: 'Maint B', subdomain: `mnt-${schoolB.slice(0, 8)}` } });
    // A suspended tenant must be skipped by the runner.
    await platform.school.create({ data: { id: suspended, name: 'Maint S', subdomain: `mnt-${suspended.slice(0, 8)}`, isActive: false } });
  });

  afterAll(async () => {
    for (const id of [schoolA, schoolB, suspended]) await destroyTenant(platform, id);
    await app.close();
  });

  it('runs mark-overdue across every ACTIVE tenant (suspended skipped)', async () => {
    const activeCount = await platform.school.count({ where: { isActive: true } });
    const res = await maintenance.run('mark-overdue');
    expect(res.schools).toBe(activeCount);
    // Our two active schools are counted; the suspended one is not (activeCount excludes it).
    expect(res.schools).toBeGreaterThanOrEqual(2);
  });

  it('runs fee-integrity-check across every active tenant without error', async () => {
    const res = await maintenance.run('fee-integrity-check');
    expect(res.schools).toBeGreaterThanOrEqual(2);
  });

  it('idempotency-purge deletes keys older than 48h, keeps recent ones', async () => {
    const old = randomUUID();
    const recent = randomUUID();
    await platform.idempotencyKey.create({
      data: { id: old, schoolId: schoolA, key: `old-${old}`, requestHash: 'h', createdAt: new Date(Date.now() - 72 * 3600 * 1000) },
    });
    await platform.idempotencyKey.create({
      data: { id: recent, schoolId: schoolA, key: `new-${recent}`, requestHash: 'h', createdAt: new Date() },
    });

    const res = await maintenance.run('idempotency-purge');
    expect(res.deleted).toBeGreaterThanOrEqual(1);
    expect(await platform.idempotencyKey.findUnique({ where: { id: old } })).toBeNull();
    expect(await platform.idempotencyKey.findUnique({ where: { id: recent } })).not.toBeNull();

    await platform.idempotencyKey.deleteMany({ where: { id: { in: [old, recent] } } });
  });

  it('sms-log-purge deletes logs older than the retention window, keeps recent ones', async () => {
    const oldLog = randomUUID();
    const recentLog = randomUUID();
    const base = { schoolId: schoolA, recipient: '+923001112222', message: 'x', templateKey: 'MANUAL', segments: 1, status: 'SENT' as const };
    await platform.smsLog.create({ data: { id: oldLog, ...base, createdAt: new Date(Date.now() - 200 * 24 * 3600 * 1000) } });
    await platform.smsLog.create({ data: { id: recentLog, ...base, createdAt: new Date() } });

    const res = await maintenance.run('sms-log-purge');
    expect(res.deleted).toBeGreaterThanOrEqual(1);
    expect(await platform.smsLog.findUnique({ where: { id: oldLog } })).toBeNull();
    expect(await platform.smsLog.findUnique({ where: { id: recentLog } })).not.toBeNull();

    await platform.smsLog.deleteMany({ where: { id: { in: [oldLog, recentLog] } } });
  });

  it('sms-monthly-credit grants each active tenant its plan credit once per month (idempotent)', async () => {
    const credited = randomUUID();
    // A fresh active tenant with NO ledger yet (default planTier BASIC → 1000 segments).
    await platform.school.create({ data: { id: credited, name: 'Maint C', subdomain: `mnt-${credited.slice(0, 8)}` } });
    try {
      const monthGrants = () =>
        platform.smsCreditLedger.findMany({ where: { schoolId: credited, refType: 'PLAN_MONTHLY' } });

      await maintenance.run('sms-monthly-credit');
      const first = await monthGrants();
      expect(first).toHaveLength(1);
      expect(first[0].delta).toBe(1000); // BASIC tier

      // Re-run in the same month → no second grant (idempotent).
      const res = await maintenance.run('sms-monthly-credit');
      expect(res.credited).toBe(0);
      expect(await monthGrants()).toHaveLength(1);
    } finally {
      await platform.smsCreditLedger.deleteMany({ where: { schoolId: credited } });
      await platform.school.delete({ where: { id: credited } });
    }
  });

  /**
   * Day close (§9/§13). This is the only job that writes payroll-affecting rows with nobody
   * pressing anything, so every guard gets its own assertion.
   */
  describe('staff-attendance-close', () => {
    const school = randomUUID();
    const sub = `mnt-${school.slice(0, 8)}`;
    let present: string; // already marked by a human
    let absentee: string; // unmarked → ABSENT
    let onLeave: string; // approved leave covers today
    let newJoiner: string; // joins tomorrow — was not employed today
    let leaver: string; // left yesterday

    const today = new Date(new Date().toISOString().slice(0, 10));
    /**
     * Weekly off defaults to SUNDAY; force a working week so the day is never skipped.
     *
     * `closeAtTime: '00:00'` is deliberate and load-bearing: the close now only runs for a school
     * whose own local close time has passed, and the default is 20:00 — so without this the whole
     * describe block would pass or fail depending on what time of day the suite ran.
     */
    const workingWeek = {
      staffAttendance: { autoMarkAbsent: true, closeAtTime: '00:00' },
      weeklyOffDays: [] as string[],
    };

    const mkStaff = async (code: string, joinedAt: Date, leftAt?: Date) => {
      const user = await platform.user.create({
        data: { schoolId: school, email: `${code}@close.pk`, roles: ['TEACHER'] as never, status: 'ACTIVE' },
      });
      const sp = await platform.staffProfile.create({
        data: { schoolId: school, userId: user.id, employeeCode: code, staffType: 'TEACHER', designation: 'T', joinedAt, leftAt },
      });
      return sp.id;
    };

    beforeAll(async () => {
      await platform.school.create({ data: { id: school, name: 'Close School', subdomain: sub, settings: workingWeek } });
      const longAgo = new Date(Date.now() - 400 * 86400000);
      present = await mkStaff('C-PRESENT', longAgo);
      absentee = await mkStaff('C-ABSENT', longAgo);
      onLeave = await mkStaff('C-LEAVE', longAgo);
      newJoiner = await mkStaff('C-NEW', new Date(Date.now() + 86400000));
      leaver = await mkStaff('C-LEFT', longAgo, new Date(Date.now() - 86400000));

      await platform.staffAttendance.create({
        data: { schoolId: school, staffId: present, date: today, session: 'MORNING', status: 'PRESENT', source: 'SELF' },
      });
      await platform.staffLeave.create({
        data: {
          schoolId: school, staffId: onLeave, leaveType: 'CASUAL', status: 'APPROVED',
          fromDate: today, toDate: today, reason: 'Family',
        },
      });
    });

    afterAll(async () => { await destroyTenant(platform, school); });

    const rowFor = (staffId: string) =>
      platform.staffAttendance.findFirst({ where: { schoolId: school, staffId, date: today } });

    it('marks the unmarked, respects leave, and never touches what a human recorded', async () => {
      const res = await maintenance.run('staff-attendance-close');
      expect(res.marked).toBeGreaterThanOrEqual(2);

      // Unmarked ⇒ ABSENT, attributed to the machine so it can be told apart and disputed.
      expect(await rowFor(absentee)).toMatchObject({ status: 'ABSENT', source: 'SYSTEM' });
      // Approved leave ⇒ ON_LEAVE, not ABSENT: authorised absence must not be punished.
      expect(await rowFor(onLeave)).toMatchObject({ status: 'ON_LEAVE', source: 'SYSTEM' });
      // A human already spoke — the job must never overwrite them.
      expect(await rowFor(present)).toMatchObject({ status: 'PRESENT', source: 'SELF' });
      // Nobody is invented for a person who was not employed on the day.
      expect(await rowFor(newJoiner)).toBeNull();
      expect(await rowFor(leaver)).toBeNull();
    });

    /**
     * G2: the close time is per school. It used to be one fleet-wide cron at 20:00 in the
     * server's timezone, so a morning school that ends at 13:00 had its register held open for
     * seven hours — and a teacher who arrived after the fleet close could not check in at all,
     * because their ABSENT row already existed.
     *
     * The job now ticks hourly and settles only the schools whose own time has passed. This is
     * the assertion that keeps that true: a school whose close time is still ahead is left alone,
     * even though it has opted in and has unmarked staff sitting there.
     */
    it('leaves a school alone until its own close time has passed', async () => {
      const later = randomUUID();
      const laterStaff = await (async () => {
        await platform.school.create({
          data: {
            id: later,
            name: 'Evening School',
            subdomain: `mnt-late-${later.slice(0, 8)}`,
            // 23:59 — never reached during a test run, so this school is always "not yet".
            settings: { staffAttendance: { autoMarkAbsent: true, closeAtTime: '23:59' }, weeklyOffDays: [] },
          },
        });
        const user = await platform.user.create({
          data: { schoolId: later, email: `late-${later.slice(0, 8)}@close.pk`, roles: ['TEACHER'] as never, status: 'ACTIVE' },
        });
        const sp = await platform.staffProfile.create({
          data: {
            schoolId: later, userId: user.id, employeeCode: `L-${later.slice(0, 6)}`,
            staffType: 'TEACHER', designation: 'T', joinedAt: new Date(Date.now() - 400 * 86400000),
          },
        });
        return sp.id;
      })();

      await maintenance.run('staff-attendance-close');

      // Unmarked, opted in, employed, working day — and still untouched, purely because it is
      // not this school's hour yet.
      expect(await platform.staffAttendance.findFirst({ where: { schoolId: later, staffId: laterStaff, date: today } })).toBeNull();

      await platform.staffProfile.deleteMany({ where: { schoolId: later } });
      await platform.user.deleteMany({ where: { schoolId: later } });
      await platform.school.delete({ where: { id: later } });
    });

    it('is idempotent — a second run writes nothing', async () => {
      const before = await platform.staffAttendance.count({ where: { schoolId: school } });
      const res = await maintenance.run('staff-attendance-close');
      expect(res.marked).toBe(0);
      expect(await platform.staffAttendance.count({ where: { schoolId: school } })).toBe(before);
    });

    it('does nothing for a school that has not opted in', async () => {
      // The default. A school acquires salary deductions by choosing them, never by upgrading.
      const optedOut = randomUUID();
      await platform.school.create({
        data: { id: optedOut, name: 'Opt Out', subdomain: `mnt-${optedOut.slice(0, 8)}`, settings: { weeklyOffDays: [] } },
      });
      try {
        const user = await platform.user.create({
          data: { schoolId: optedOut, email: 'x@optout.pk', roles: ['TEACHER'] as never, status: 'ACTIVE' },
        });
        await platform.staffProfile.create({
          data: {
            schoolId: optedOut, userId: user.id, employeeCode: 'OO-1', staffType: 'TEACHER',
            designation: 'T', joinedAt: new Date(Date.now() - 400 * 86400000),
          },
        });
        await maintenance.run('staff-attendance-close');
        expect(await platform.staffAttendance.count({ where: { schoolId: optedOut } })).toBe(0);
      } finally {
        await destroyTenant(platform, optedOut);
      }
    });

    it('skips a holiday, and skips a month whose payroll is already approved', async () => {
      const other = randomUUID();
      await platform.school.create({
        data: { id: other, name: 'Guard School', subdomain: `mnt-${other.slice(0, 8)}`, settings: workingWeek },
      });
      try {
        const user = await platform.user.create({
          data: { schoolId: other, email: 'g@guard.pk', roles: ['TEACHER'] as never, status: 'ACTIVE' },
        });
        const staffId = (await platform.staffProfile.create({
          data: {
            schoolId: other, userId: user.id, employeeCode: 'G-1', staffType: 'TEACHER',
            designation: 'T', joinedAt: new Date(Date.now() - 400 * 86400000),
          },
        })).id;

        // A holiday must not be able to manufacture an absence.
        const holiday = await platform.holiday.create({
          data: { schoolId: other, date: today, name: 'Test Holiday' },
        });
        await maintenance.run('staff-attendance-close');
        expect(await platform.staffAttendance.count({ where: { schoolId: other } })).toBe(0);
        await platform.holiday.delete({ where: { id: holiday.id } });

        // A payslip computed from these rows must not start disagreeing with them — but the
        // freeze is PER CAMPUS. Two campuses, one payroll approved: the settled campus is
        // skipped, the other still closes. A single-campus fixture cannot tell those apart,
        // which is exactly how the campus-blind version shipped.
        const campusA = await platform.campus.create({ data: { schoolId: other, name: 'Main' } });
        const campusB = await platform.campus.create({ data: { schoolId: other, name: 'Second' } });
        await platform.user.update({ where: { id: user.id }, data: { campusId: campusA.id } });

        const userB = await platform.user.create({
          data: { schoolId: other, campusId: campusB.id, email: 'b@guard.pk', roles: ['TEACHER'] as never, status: 'ACTIVE' },
        });
        const staffB = (await platform.staffProfile.create({
          data: {
            schoolId: other, userId: userB.id, employeeCode: 'G-2', staffType: 'TEACHER',
            designation: 'T', joinedAt: new Date(Date.now() - 400 * 86400000),
          },
        })).id;

        const run = await platform.payrollRun.create({
          data: {
            schoolId: other, campusId: campusA.id, month: today.getUTCMonth() + 1, year: today.getUTCFullYear(),
            status: 'APPROVED', createdById: user.id,
          },
        });
        await maintenance.run('staff-attendance-close');
        expect(await platform.staffAttendance.findFirst({ where: { schoolId: other, staffId } })).toBeNull();
        expect(await platform.staffAttendance.findFirst({ where: { schoolId: other, staffId: staffB } }))
          .toMatchObject({ status: 'ABSENT', source: 'SYSTEM' });

        // With the run reversed to DRAFT, campus A closes too — proving it was held back by the
        // guard and not by some unrelated obstacle.
        await platform.payrollRun.update({ where: { id: run.id }, data: { status: 'DRAFT' } });
        await maintenance.run('staff-attendance-close');
        expect(await platform.staffAttendance.findFirst({ where: { schoolId: other, staffId } }))
          .toMatchObject({ status: 'ABSENT', source: 'SYSTEM' });
      } finally {
        await destroyTenant(platform, other);
      }
    });
  });
});
