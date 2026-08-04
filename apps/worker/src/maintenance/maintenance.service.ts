import { Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AttendanceSource, AttendanceStatus } from '@prisma/client';
import { captureError, CLS_KEYS, parseSchoolSettings, type SchoolSettings } from '@common';
import { PlatformPrismaService, TenantPrismaService } from '@database';
import { FeeJobsService } from '../../../api/src/modules/fees/fee-jobs.service';
import { PLAN_MONTHLY_SMS_CREDITS } from '../../../api/src/modules/comms/sms/sms-plan-credits';

export type MaintenanceJob =
  | 'mark-overdue'
  | 'fee-integrity-check'
  | 'idempotency-purge'
  | 'sms-log-purge'
  | 'sms-monthly-credit'
  | 'staff-attendance-close';

export interface MaintenanceResult {
  /** Tenants processed (per-tenant fee jobs). */
  schools?: number;
  /** Rows deleted (global purge jobs). */
  deleted?: number;
  /** Tenants granted this month's SMS plan credit. */
  credited?: number;
  /** Staff-attendance rows written by the day-close job. */
  marked?: number;
}

const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;
const startOfDay = (d: Date): number => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/** Idempotency keys expire after 48h (blueprint §25.4). */
const IDEMPOTENCY_TTL_MS = 48 * 60 * 60 * 1000;
/** SMS logs retained ~180 days (billing/audit) then purged (§27). */
const SMS_LOG_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Cross-tenant nightly maintenance (blueprint §27). Fee jobs run per active tenant
 * (each in its own CLS + RLS-bound `withTenant` tx, like a request); global purges run
 * once across all tenants on the platform_admin (BYPASSRLS) connection. A failure in one
 * tenant is logged + Sentry-reported and doesn't abort the rest.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    private readonly cls: ClsService,
    private readonly platform: PlatformPrismaService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly feeJobs: FeeJobsService,
  ) {}

  async run(job: MaintenanceJob): Promise<MaintenanceResult> {
    switch (job) {
      case 'mark-overdue':
      case 'fee-integrity-check':
        return { schools: await this.runFeeJobPerTenant(job) };
      case 'idempotency-purge':
        return { deleted: await this.purgeIdempotencyKeys() };
      case 'sms-log-purge':
        return { deleted: await this.purgeSmsLogs() };
      case 'sms-monthly-credit':
        return { credited: await this.grantMonthlySmsCredits() };
      case 'staff-attendance-close':
        return { marked: await this.closeStaffAttendance() };
    }
  }

  /**
   * End of day: give every unmarked staff member a status (§9/§13).
   *
   * **Opt-in per school** (`staffAttendance.autoMarkAbsent`, default false) and skipped
   * entirely for any school that has not switched it on. That default is the whole safety
   * story: this job writes `ABSENT` rows, and `payroll.absentDays()` counts those straight into
   * a salary deduction — so a school acquires the behaviour by choosing it, never by upgrading.
   *
   * The rules, each guarding a way a wrong deduction gets created:
   *  - nothing at all on a non-working day, so a holiday cannot manufacture absences;
   *  - nothing for anyone not employed on that date — a guard must ask "was this true THEN";
   *  - an approved leave becomes `ON_LEAVE`, not `ABSENT`, so authorised absence is not punished;
   *  - a row that already exists is never touched, so a self check-in or the office's own entry
   *    always wins over the machine;
   *  - a month whose payroll is already APPROVED is skipped, or a paid payslip would stop
   *    agreeing with the register it came from.
   *
   * Idempotent: re-running writes nothing new.
   */
  private async closeStaffAttendance(): Promise<number> {
    const schools = await this.platform.school.findMany({ where: { isActive: true }, select: { id: true, settings: true } });
    let marked = 0;

    // Wall-clock HH:MM on the server, compared as a string — both sides are zero-padded 24h, so
    // lexical order is chronological order.
    //
    // ⚠️ "Local" is the SERVER's timezone (prod sets TZ=Asia/Karachi), not the school's: there is
    // no per-tenant timezone yet. Correct while every tenant is a Pakistani school on one server,
    // and wrong the moment one is not — that is G4, and this comparison is one of the places it
    // will bite. Recorded rather than silently assumed.
    const now = new Date();
    const nowHhMm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    for (const school of schools) {
      const settings = parseSchoolSettings(school.settings ?? {});
      if (!settings.staffAttendance.autoMarkAbsent) continue;
      // Each school settles at its own hour. The job ticks hourly, so before a school's close
      // time this is simply not its turn yet; after it, the pass is a no-op because every row it
      // would write already exists.
      if (nowHhMm < settings.staffAttendance.closeAtTime) continue;

      await this.cls.run(async () => {
        this.cls.set(CLS_KEYS.schoolId, school.id);
        try {
          await this.tenantPrisma.withTenant(async () => {
            marked += await this.closeOneSchool(school.id, settings);
          });
        } catch (err) {
          this.logger.error(`staff-attendance-close failed for school ${school.id}: ${(err as Error).message}`);
          captureError(err, { schoolId: school.id });
        }
      });
    }
    if (marked > 0) this.logger.log(`staff-attendance-close: recorded ${marked} staff attendance row(s)`);
    return marked;
  }

  private async closeOneSchool(schoolId: string, settings: SchoolSettings): Promise<number> {
    const db = this.tenantPrisma.client;
    const today = new Date(new Date().toISOString().slice(0, 10));
    const session = settings.attendanceSessions[0];

    // A payslip computed from these rows must not start disagreeing with them — but the freeze
    // is PER CAMPUS. `PayrollRun` is unique on [schoolId, campusId, month, year], so approving
    // one campus on the 25th must not stop the day close for the school's other campuses.
    const approvedRuns = await db.payrollRun.findMany({
      where: { month: today.getUTCMonth() + 1, year: today.getUTCFullYear(), status: 'APPROVED' },
      select: { campusId: true },
    });
    const frozenCampuses = new Set(approvedRuns.map((r) => r.campusId));
    if (frozenCampuses.size) {
      this.logger.log(`staff-attendance-close: school ${schoolId} — ${frozenCampuses.size} campus(es) frozen by approved payroll`);
    }

    const weeklyOff = settings.weeklyOffDays.includes(WEEKDAYS[today.getUTCDay()]);
    if (weeklyOff) return 0;

    const staff = await db.staffProfile.findMany({
      where: { user: { deletedAt: null }, joinedAt: { lte: today } },
      select: { id: true, leftAt: true, user: { select: { campusId: true } } },
    });
    if (!staff.length) return 0;

    // Holidays can be campus-specific, so resolve them once and test per person.
    const holidays = await db.holiday.findMany({ where: { date: today }, select: { campusId: true } });
    const schoolWideHoliday = holidays.some((h) => h.campusId === null);
    const holidayCampuses = new Set(holidays.map((h) => h.campusId).filter(Boolean) as string[]);
    if (schoolWideHoliday) return 0;

    const already = await db.staffAttendance.findMany({
      where: { date: today, session, staffId: { in: staff.map((s) => s.id) } },
      select: { staffId: true },
    });
    const marked = new Set(already.map((a) => a.staffId));

    const leaves = await db.staffLeave.findMany({
      where: { status: 'APPROVED', fromDate: { lte: today }, toDate: { gte: today } },
      select: { staffId: true },
    });
    const onLeave = new Set(leaves.map((l) => l.staffId));

    let written = 0;
    for (const s of staff) {
      if (marked.has(s.id)) continue; // a human already said something — never overwrite it
      if (s.leftAt && startOfDay(s.leftAt) < startOfDay(today)) continue;
      if (s.user.campusId && holidayCampuses.has(s.user.campusId)) continue;
      // Their campus's pay is settled for the month; theirs alone is skipped.
      if (s.user.campusId && frozenCampuses.has(s.user.campusId)) continue;

      await db.staffAttendance.create({
        data: {
          schoolId, staffId: s.id, date: today, session,
          status: onLeave.has(s.id) ? AttendanceStatus.ON_LEAVE : AttendanceStatus.ABSENT,
          source: AttendanceSource.SYSTEM,
        },
      });
      written++;
    }
    return written;
  }

  /** Run a fee job for every ACTIVE tenant, isolated per school. */
  private async runFeeJobPerTenant(job: 'mark-overdue' | 'fee-integrity-check'): Promise<number> {
    const schools = await this.platform.school.findMany({ where: { isActive: true }, select: { id: true } });
    for (const school of schools) {
      await this.cls.run(async () => {
        this.cls.set(CLS_KEYS.schoolId, school.id);
        try {
          await this.tenantPrisma.withTenant(async () => {
            if (job === 'mark-overdue') {
              await this.feeJobs.markOverdue();
            } else {
              const result = await this.feeJobs.checkIntegrity();
              if (!result.ok) {
                // §27: a fee-integrity mismatch pages on-call. Surface it loudly.
                this.logger.warn(`fee-integrity mismatch in school ${school.id}: ${result.mismatches.length} invoice(s)`);
                captureError(new Error('fee-integrity mismatch'), { schoolId: school.id });
              }
            }
          });
        } catch (err) {
          this.logger.error(`maintenance "${job}" failed for school ${school.id}: ${(err as Error).message}`);
          captureError(err, { schoolId: school.id });
        }
      });
    }
    return schools.length;
  }

  /** Global purge (all tenants, one query) via the BYPASSRLS connection. */
  private async purgeIdempotencyKeys(): Promise<number> {
    const cutoff = new Date(Date.now() - IDEMPOTENCY_TTL_MS);
    const { count } = await this.platform.idempotencyKey.deleteMany({ where: { createdAt: { lt: cutoff } } });
    this.logger.log(`idempotency-purge: deleted ${count} key(s) older than 48h`);
    return count;
  }

  private async purgeSmsLogs(): Promise<number> {
    const cutoff = new Date(Date.now() - SMS_LOG_RETENTION_MS);
    const { count } = await this.platform.smsLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    this.logger.log(`sms-log-purge: deleted ${count} log(s) older than 180d`);
    return count;
  }

  /**
   * Refresh each ACTIVE tenant's monthly SMS plan credit (§14). Runs on the 1st; a
   * cross-tenant billing grant, so it uses the platform (BYPASSRLS) connection (§21.5).
   * Idempotent per calendar month: skip any tenant that already has a PLAN_MONTHLY grant
   * this month (the provisioning grant counts, so a tenant onboarded mid-month isn't
   * double-credited). Safe to re-run — BullMQ fires it once fleet-wide anyway.
   */
  private async grantMonthlySmsCredits(): Promise<number> {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    const schools = await this.platform.school.findMany({
      where: { isActive: true },
      select: { id: true, planTier: true },
    });
    let credited = 0;
    for (const school of schools) {
      const alreadyGranted = await this.platform.smsCreditLedger.findFirst({
        where: { schoolId: school.id, refType: 'PLAN_MONTHLY', createdAt: { gte: monthStart, lt: nextMonth } },
        select: { id: true },
      });
      if (alreadyGranted) continue;
      await this.platform.smsCreditLedger.create({
        data: { schoolId: school.id, delta: PLAN_MONTHLY_SMS_CREDITS[school.planTier], refType: 'PLAN_MONTHLY' },
      });
      credited++;
    }
    this.logger.log(`sms-monthly-credit: granted this month's SMS plan credit to ${credited} tenant(s)`);
    return credited;
  }
}
