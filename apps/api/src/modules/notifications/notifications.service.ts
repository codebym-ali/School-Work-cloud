import { Injectable } from '@nestjs/common';
import { AttendanceStatus, LeaveStatus } from '@prisma/client';
import { isPastLocalTime, parseSchoolSettings, TenantContext } from '@common';
import { TenantPrismaService } from '@database';
import { DashboardService } from '../reports/insights.service';
import { AttendanceService } from '../attendance/attendance.service';
import { ClaimsService } from '../fees/claims.service';
import { AdmissionsService } from '../admissions/admissions.service';

/**
 * "What changed for me" (Notifications Plan, N0).
 *
 * **Every item is DERIVED from the record it describes** — there is no notifications table, and
 * that is the design, not a shortcut. A stored notice is a copy of state, and copies disagreeing
 * is what has cost this codebase most: three copies of the attendance percentage once gave a
 * parent, a teacher and a director three different figures for one child. A row saying "your
 * leave was approved" that outlives the approval is the same failure aimed at a person. Because
 * these are computed, an item stops existing the moment its cause does.
 *
 * **Who this is for.** The roles without a dashboard. `/dashboard` — and the "Needs attention"
 * strip on it — is OWNER_ADMIN / CAMPUS_ADMIN / ACCOUNTANT only; a teacher lands on `/attendance`
 * and staff on `/my-attendance`, so until now they had nowhere at all that said what changed.
 * N0 is deliberately staff-side; students and the admin strip follow in N2.
 *
 * **It must never throw.** The app shell calls this for every signed-in user on every page, so an
 * account with no staff profile (a student, an owner who is not also staff) gets an empty list,
 * not a 403. A notification bell is not worth breaking a page over.
 *
 * `at` on each item is when the underlying record last changed; `isNew` compares it against the
 * caller's `User.notificationsSeenAt`. That one column is the whole of "unread" — a notifications
 * table would have bought the same behaviour at the price of a copy of state that can disagree
 * with the thing it copied.
 */
export type NotificationItem = {
  /** Stable across calls, so a still-unread item is not mistaken for a new one. */
  id: string;
  kind:
    | 'LEAVE_DECIDED' | 'REGISTER_UNMARKED' | 'MARKED_ABSENT' | 'SALARY_PAID'
    // "What the school needs from you" (N2) — previously derived in `dashboard/page.tsx`.
    | 'DEFAULTERS' | 'LEAVES_PENDING' | 'SMS_FAILED' | 'CLAIMS_PENDING'
    | 'REGISTERS_UNMARKED' | 'STAFF_UNMARKED' | 'STAFF_ABSENT'
    | 'READY_TO_ADMIT' | 'TESTS_TODAY';
  severity: 'info' | 'warn';
  text: string;
  href: string;
  at: string;
};

/**
 * ⚠️ **Role gates, restated.**
 *
 * The services composed below are called DIRECTLY, so the `@Roles` decorators that normally
 * protect them — which live on their controllers — do not run. Every gate here is copied from the
 * controller that owns the data, and getting one wrong hands a teacher the whole school's figures.
 * If a gate changes there, it must change here; the e2e asserts a TEACHER receives none of these.
 */
const NEEDS = {
  /** `GET /attendance/unmarked-today` */
  unmarkedRegisters: ['OWNER_ADMIN', 'CAMPUS_ADMIN'],
  /** `GET /staff-attendance/summary` */
  staffDay: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'HR_MANAGER'],
  /** `GET /fees/claims/pending-count` */
  claims: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT'],
  /** `GET /inquiries/summary` */
  admissions: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER'],
  /** `GET /dashboard` — self-shaping: it returns `visible` and nulls what a role may not see. */
  dashboard: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT'],
} as const;

/** How far back an event is still worth mentioning. Beyond this it is history, not news. */
const RECENT_DAYS = { leave: 14, absence: 7, salary: 30 } as const;

const daysAgo = (n: number): Date => new Date(Date.now() - n * 86400000);
const dayMonth = (d: Date): string =>
  new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

@Injectable()
export class NotificationsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    // Composed, not reimplemented. These own the derivations; this service's job is to decide
    // whose business each figure is and to turn it into a sentence — which is precisely the part
    // that was duplicated between the dashboard strip and the bell.
    private readonly insights: DashboardService,
    private readonly attendance: AttendanceService,
    private readonly claims: ClaimsService,
    private readonly admissions: AdmissionsService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  async forCaller(): Promise<{ items: NotificationItem[]; unread: number }> {
    const user = this.ctx.user;
    if (!user) return { items: [], unread: 0 };

    const [staff, account] = await Promise.all([
      this.db.staffProfile.findFirst({ where: { userId: user.userId }, select: { id: true } }),
      this.db.user.findFirst({ where: { id: user.userId }, select: { notificationsSeenAt: true } }),
    ]);

    // Two halves, and a person can have either, both or neither. **Personal** items hang off a
    // staff profile — an owner who is not also staff has none, and that is not an error. **School**
    // items hang off role, and they used to live only on `/dashboard`, which ADMISSION_CONTROLLER
    // and HR_MANAGER cannot open either: both land elsewhere, so neither had ever seen them.
    const personal = staff
      ? (
          await Promise.all([
            this.leaveDecided(staff.id),
            this.markedAbsent(staff.id),
            this.salaryPaid(staff.id),
            user.roles.includes('TEACHER') ? this.registerUnmarked(staff.id) : Promise.resolve([]),
          ])
        ).flat()
      : [];

    const raw = [...personal, ...(await this.needsAttention(user.roles))];
    if (!raw.length) return { items: [], unread: 0 };

    // Newest first — and `at` is the record's own timestamp, so this is the order things actually
    // happened in, not the order the queries returned.
    const seenAt = account?.notificationsSeenAt;
    const items = raw
      .sort((a, b) => b.at.localeCompare(a.at))
      // Null `seenAt` means never opened, which correctly makes everything new the first time.
      .map((i) => ({ ...i, isNew: !seenAt || new Date(i.at) > seenAt }));

    // Counted from the SAME list that is returned, never queried separately. A bell reading "3"
    // that opens onto two items is worse than no bell, and two round trips is exactly how the
    // count and the list start disagreeing.
    return { items, unread: items.filter((i) => i.isNew).length };
  }

  /**
   * "What the school needs from you" — the chips that used to be assembled in `dashboard/page.tsx`
   * (N2).
   *
   * Moved here for two reasons, and the second is the one that mattered on inspection:
   *  - the phrasing and the thresholds were about to exist twice, once for the strip and once for
   *    the bell, and two of those drift;
   *  - **the strip only ever appeared on `/dashboard`**, which is OWNER_ADMIN / CAMPUS_ADMIN /
   *    ACCOUNTANT. An ADMISSION_CONTROLLER lands on `/admissions` and an HR_MANAGER on `/staff`,
   *    so neither had ever been shown "5 students ready to admit" or "3 staff not marked today" —
   *    the very things their job is. Deriving by role rather than by page fixes that outright.
   *
   * Every source is wrapped: a role denial or a missing academic year must produce silence, not a
   * broken bell in the corner of every page.
   */
  private async needsAttention(roles: readonly string[]): Promise<NotificationItem[]> {
    const can = (allowed: readonly string[]) => roles.some((r) => allowed.includes(r));
    const at = new Date().toISOString();
    const out: NotificationItem[] = [];
    const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
    const attempt = async (allowed: readonly string[], fn: () => Promise<void>) => {
      if (!can(allowed)) return;
      try { await fn(); } catch { /* denied or unavailable — say nothing */ }
    };

    await Promise.all([
      attempt(NEEDS.dashboard, async () => {
        // Self-shaping: `visible` says which figures this role is allowed, and the rest come back
        // null. Trusting that is what keeps an accountant from being told the attendance figures.
        const d = await this.insights.get();
        const v = d.visible as string[];
        if (v.includes('defaulterCount') && d.defaulterCount > 0) {
          out.push({ id: `defaulters:${d.defaulterCount}`, kind: 'DEFAULTERS', severity: 'warn', at,
            text: `${d.defaulterCount} fee ${plural(d.defaulterCount, 'defaulter', 'defaulters')}.`, href: '/reports' });
        }
        if (v.includes('pendingLeaves') && (d.pendingLeaves ?? 0) > 0) {
          out.push({ id: `leaves-pending:${d.pendingLeaves}`, kind: 'LEAVES_PENDING', severity: 'warn', at,
            text: `${d.pendingLeaves} leave ${plural(d.pendingLeaves!, 'request', 'requests')} waiting for a decision.`, href: '/leaves' });
        }
        if (v.includes('failedSmsCount') && (d.failedSmsCount ?? 0) > 0) {
          out.push({ id: `sms-failed:${d.failedSmsCount}`, kind: 'SMS_FAILED', severity: 'warn', at,
            text: `${d.failedSmsCount} failed SMS.`, href: '/reports' });
        }
      }),

      attempt(NEEDS.unmarkedRegisters, async () => {
        const u = await this.attendance.unmarkedToday();
        // Only once the school's own deadline has passed — before it, an unmarked register is a
        // lesson that has not happened yet, and nagging then is how a warning becomes wallpaper.
        if (!u.due || u.count === 0) return;
        out.push({ id: `registers-unmarked:${u.count}`, kind: 'REGISTERS_UNMARKED', severity: 'warn', at,
          text: `${u.count} ${plural(u.count, 'register', 'registers')} not marked today.`, href: '/attendance?unmarked=1' });
      }),

      attempt(NEEDS.staffDay, async () => {
        const s = await this.attendance.staffDaySummary();
        if (!s.workingDay) return; // a holiday cannot be behind on anything
        if (s.absent > 0) {
          out.push({ id: `staff-absent:${s.date}:${s.absent}`, kind: 'STAFF_ABSENT', severity: 'warn', at,
            text: `${s.absent} staff absent today.`, href: `/staff-attendance?date=${s.date}&status=ABSENT` });
        }
        // Deliberately chased instead of an absent count over a half-kept register: nothing writes
        // an ABSENT row on its own unless the school turned that on, so "not marked" is the honest
        // gap and "0 absent" from an empty register would be a reassuring lie.
        if (s.unmarked > 0) {
          out.push({ id: `staff-unmarked:${s.date}:${s.unmarked}`, kind: 'STAFF_UNMARKED', severity: 'warn', at,
            text: `${s.unmarked} staff not marked today.`, href: `/staff-attendance?date=${s.date}&status=UNMARKED` });
        }
      }),

      attempt(NEEDS.claims, async () => {
        const pending = await this.claims.pendingCount();
        if (pending === 0) return;
        out.push({ id: `claims:${pending}`, kind: 'CLAIMS_PENDING', severity: 'warn', at,
          text: `${pending} ${plural(pending, 'payment', 'payments')} awaiting verification.`, href: '/fee-claims' });
      }),

      attempt(NEEDS.admissions, async () => {
        // Every figure counts Inquiry rows, so a DIRECT school reads 0 for ever by design. Asking
        // is harmless — zero produces no item — and it saves this service knowing the mode.
        const a = await this.admissions.summary();
        if (a.totals.readyToAdmit > 0) {
          out.push({ id: `ready-to-admit:${a.totals.readyToAdmit}`, kind: 'READY_TO_ADMIT', severity: 'info', at,
            text: `${a.totals.readyToAdmit} ${plural(a.totals.readyToAdmit, 'student', 'students')} ready to admit.`, href: '/admissions' });
        }
        if (a.testsToday > 0) {
          out.push({ id: `tests-today:${a.testsToday}`, kind: 'TESTS_TODAY', severity: 'info', at,
            text: `${a.testsToday} entry ${plural(a.testsToday, 'test', 'tests')} today.`, href: '/admissions' });
        }
      }),
    ]);

    return out;
  }

  /**
   * Mark everything currently visible as seen.
   *
   * Stamped with **now**, not with the newest item's `at`: the question this answers is "when did
   * you last look", and the person looked now. Using the newest item's timestamp would leave a
   * notice created a second later looking older than the visit that missed it.
   *
   * Idempotent, and safe for an account with no staff profile — it simply records a visit nobody
   * will ever compare anything against.
   */
  async markSeen(): Promise<{ seenAt: string }> {
    const user = this.ctx.user;
    const seenAt = new Date();
    if (user) {
      await this.db.user.update({ where: { id: user.userId }, data: { notificationsSeenAt: seenAt } });
    }
    return { seenAt: seenAt.toISOString() };
  }

  /**
   * The one that prompted the whole feature: a teacher's leave is decided and nobody tells them.
   * A rejection carries the reason the office was **required** to type — leaving that on a row
   * the person has to go and find is what made the requirement pointless.
   */
  private async leaveDecided(staffId: string): Promise<NotificationItem[]> {
    const leaves = await this.db.staffLeave.findMany({
      where: {
        staffId,
        status: { in: [LeaveStatus.APPROVED, LeaveStatus.REJECTED] },
        decidedAt: { gte: daysAgo(RECENT_DAYS.leave) },
      },
      select: { id: true, status: true, leaveType: true, fromDate: true, toDate: true, isUnpaid: true, rejectionReason: true, decidedAt: true },
    });

    return leaves.map((l) => {
      const when = `${dayMonth(l.fromDate)}${dayMonth(l.fromDate) === dayMonth(l.toDate) ? '' : `–${dayMonth(l.toDate)}`}`;
      const type = l.leaveType.toLowerCase();
      const approved = l.status === LeaveStatus.APPROVED;
      return {
        // Status is in the id on purpose: a leave that flips decision is a different notice, and
        // N1 must treat it as new rather than as one the person already read.
        id: `leave:${l.id}:${l.status}`,
        kind: 'LEAVE_DECIDED' as const,
        severity: approved ? ('info' as const) : ('warn' as const),
        text: approved
          ? `Your ${type} leave for ${when} was approved${l.isUnpaid ? ' — it will be unpaid' : ''}.`
          : `Your ${type} leave for ${when} was rejected${l.rejectionReason ? ` — ${l.rejectionReason}` : ''}.`,
        href: '/my-leaves',
        at: (l.decidedAt ?? new Date()).toISOString(),
      };
    });
  }

  /**
   * You were recorded absent. Surfaced because it is the **dispute path**: staff attendance feeds
   * the payroll deduction, and someone who is never told cannot correct a mistake before it
   * reaches their salary. ON_LEAVE is not included — that is the system agreeing with them.
   */
  private async markedAbsent(staffId: string): Promise<NotificationItem[]> {
    const rows = await this.db.staffAttendance.findMany({
      where: { staffId, status: AttendanceStatus.ABSENT, date: { gte: daysAgo(RECENT_DAYS.absence) } },
      select: { id: true, date: true, updatedAt: true },
    });
    return rows.map((r) => ({
      id: `absent:${r.id}`,
      kind: 'MARKED_ABSENT' as const,
      severity: 'warn' as const,
      text: `You were marked absent on ${dayMonth(r.date)}. If that is wrong, tell the office — it affects your pay.`,
      href: '/my-attendance',
      at: r.updatedAt.toISOString(),
    }));
  }

  /** Money arrived. `paidAt` is a real event with a real timestamp, unlike payroll approval —
   *  `PayrollRun` records `approvedById` but no `approvedAt`, so "your payslip is ready" cannot
   *  currently be dated honestly and is left out rather than dated from the DRAFT's creation. */
  private async salaryPaid(staffId: string): Promise<NotificationItem[]> {
    const slips = await this.db.payslip.findMany({
      where: { staffId, paidAt: { gte: daysAgo(RECENT_DAYS.salary) } },
      select: { id: true, netPay: true, paidAt: true, run: { select: { month: true, year: true } } },
    });
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return slips.map((s) => ({
      id: `payslip:${s.id}`,
      kind: 'SALARY_PAID' as const,
      severity: 'info' as const,
      text: `Your salary for ${MONTHS[s.run.month - 1]} ${s.run.year} was paid — Rs ${Number(s.netPay).toLocaleString('en-PK')}.`,
      href: '/my-payslips',
      at: s.paidAt!.toISOString(),
    }));
  }

  /**
   * Your own register is not marked yet — **one line a day, not one per section**.
   *
   * G3 built this for the head teacher, who needed to see which classes were behind. Pointing the
   * same data at the individual teacher is the more useful place for it, but it changes character:
   * a per-section list aimed at one person reads as nagging, and G3's rule was *surface, don't
   * police*. So it collapses to a single reminder, and it stays silent until the school's own
   * `attendanceMarkByTime` has passed — before that a blank register is just a lesson that has
   * not happened yet, and complaining then teaches people to ignore the complaint.
   */
  private async registerUnmarked(staffId: string): Promise<NotificationItem[]> {
    const schoolId = this.ctx.requireSchoolId();
    const school = await this.db.school.findFirst({ where: { id: schoolId }, select: { settings: true } });
    const settings = parseSchoolSettings(school?.settings ?? {});
    const now = new Date();
    if (!isPastLocalTime(now, settings.attendanceMarkByTime, settings.timezone)) return [];

    const year = await this.db.academicYear.findFirst({ where: { isCurrent: true }, select: { id: true } });
    if (!year) return [];

    const session = settings.attendanceSessions[0];
    const today = new Date(new Date().toISOString().slice(0, 10));

    // A closure or weekly off is not a gap. Crying wolf every Sunday is how a warning becomes
    // wallpaper — the same reason the coverage strip and the day-close job both check this.
    const WEEK = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;
    if (settings.weeklyOffDays.includes(WEEK[today.getUTCDay()])) return [];
    if (await this.db.holiday.count({ where: { date: today } })) return [];

    // Only the sections THIS teacher is responsible for.
    const assignments = await this.db.teacherAssignment.findMany({
      where: { staffId, academicYearId: year.id },
      select: { sectionId: true },
    });
    const sectionIds = [...new Set(assignments.map((a) => a.sectionId))];
    if (!sectionIds.length) return [];

    let outstanding = 0;
    for (const sectionId of sectionIds) {
      const [expected, marked] = await Promise.all([
        this.db.studentEnrollment.count({
          where: { sectionId, academicYearId: year.id, status: 'ACTIVE', student: { deletedAt: null }, startedAt: { lte: today } },
        }),
        this.db.attendanceRecord.count({
          where: { date: today, session, enrollment: { sectionId, academicYearId: year.id } },
        }),
      ]);
      // A section with nobody in it cannot be behind on anything.
      if (expected > 0 && marked < expected) outstanding++;
    }
    if (!outstanding) return [];

    return [{
      // Dated, so it is a fresh reminder each day rather than one that never goes away.
      id: `register:${today.toISOString().slice(0, 10)}`,
      kind: 'REGISTER_UNMARKED' as const,
      severity: 'warn' as const,
      text: outstanding === 1
        ? 'One of your registers is not marked yet today.'
        : `${outstanding} of your registers are not marked yet today.`,
      href: '/attendance',
      // The deadline itself, not "now" — so the item does not appear to move every time it is read.
      at: new Date(`${today.toISOString().slice(0, 10)}T${settings.attendanceMarkByTime}:00.000Z`).toISOString(),
    }];
  }
}
