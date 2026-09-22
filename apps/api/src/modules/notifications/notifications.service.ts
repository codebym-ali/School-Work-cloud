import { Injectable } from '@nestjs/common';
import { AttendanceStatus, LeaveStatus, PayrollRunStatus } from '@prisma/client';
import { restrictedCampusId, TenantContext } from '@common';
import { TenantPrismaService } from '@database';
import { CoverService } from '../cover/cover.service';
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
    | 'READY_TO_ADMIT' | 'TESTS_TODAY'
    // Cover (C2): one for the person taking the class, one for the person whose class it is.
    | 'COVERING_TODAY' | 'COVERED_TODAY'
    // The school is shut today or tomorrow. Everyone's business, not a role's.
    | 'SCHOOL_CLOSED'
    // Approved salaries not yet handed over (Cash Payroll Plan, WS3.1).
    | 'SALARIES_TO_PAY';
  severity: 'info' | 'warn';
  text: string;
  href: string;
  at: string;
  /**
   * When this became KNOWABLE, when that differs from the timestamp shown.
   *
   * ⚠️ **Only a closure needs it, and without it the badge could never be cleared.** A closure
   * declared tonight for tomorrow carries `at` = tomorrow's date, which is in the future — so
   * `at > seenAt` stayed true no matter how many times the person opened the bell, and the count
   * sat there forever. Newness is about when the school found out, not about the day being
   * described. Everything else leaves it unset and `at` answers both questions.
   */
  knownAt?: string;
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
  /** `GET /payroll-runs` — the people who hand over salaries. */
  salaries: ['OWNER_ADMIN', 'ACCOUNTANT'],
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
    private readonly cover: CoverService,
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
            user.roles.includes('TEACHER') ? this.registerUnmarked() : Promise.resolve([]),
            this.coverToday(staff.id),
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
      .map(({ knownAt, ...i }) => ({ ...i, isNew: !seenAt || new Date(knownAt ?? i.at) > seenAt }));

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
    /**
     * Run one contributor if this caller is allowed it.
     *
     * ⚠️ `allowed: null` means EVERY signed-in user, and is spelled `null` rather than an empty
     * array on purpose: an empty array reads as "nobody" at a glance, and a contributor that
     * silently reached everyone because someone typed `[]` is exactly the mistake the NEEDS map
     * exists to prevent. Only genuinely public facts — a school closure — may use it.
     */
    const attempt = async (allowed: readonly string[] | null, fn: () => Promise<void>) => {
      if (allowed !== null && !can(allowed)) return;
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
            text: `${d.defaulterCount} fee ${plural(d.defaulterCount, 'defaulter', 'defaulters')}.`, href: '/defaulters' });
        }
        if (v.includes('pendingLeaves') && (d.pendingLeaves ?? 0) > 0) {
          out.push({ id: `leaves-pending:${d.pendingLeaves}`, kind: 'LEAVES_PENDING', severity: 'warn', at,
            text: `${d.pendingLeaves} leave ${plural(d.pendingLeaves!, 'request', 'requests')} waiting for a decision.`, href: '/leaves' });
        }
        if (v.includes('failedSmsCount') && (d.failedSmsCount ?? 0) > 0) {
          out.push({ id: `sms-failed:${d.failedSmsCount}`, kind: 'SMS_FAILED', severity: 'warn', at,
            text: `${d.failedSmsCount} failed SMS.`, href: '/sms' });
        }
      }),

      attempt(NEEDS.unmarkedRegisters, async () => {
        const u = await this.attendance.unmarkedToday();
        // Only once the school's own deadline has passed — before it, an unmarked register is a
        // lesson that has not happened yet, and nagging then is how a warning becomes wallpaper.
        if (!u.due || u.count === 0) return;
        out.push({ id: `registers-unmarked:${u.count}`, kind: 'REGISTERS_UNMARKED', severity: 'warn', at,
          text: `${u.count} ${plural(u.count, 'class register', 'class registers')} past today's marking time.`, href: '/attendance?unmarked=1' });
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

      /**
       * The school is closed today or tomorrow.
       *
       * ⚠️ **No NEEDS gate, on purpose.** Every other item here is role-gated because it exposes
       * school-wide figures — money, attendance, admissions. A closure is the opposite: it is
       * public information inside the school, and the people most affected are the ones with the
       * fewest permissions. Gating it would be the mistake, not the safeguard.
       *
       * ⚠️ **Today and tomorrow only.** Beyond that it is a calendar, not news — the same rule the
       * closure banner already follows. A bell that lists next term's holidays is a bell nobody
       * opens.
       *
       * ⚠️ **Campus-scoped.** `campusId: null` means the whole school; a closure at one campus must
       * not tell the other campus to stay home.
       */
      attempt(null, async () => {
        const today = startOfUtcDay(new Date());
        const tomorrow = new Date(today.getTime() + 86_400_000);
        const campusId = this.ctx.user?.campusId ?? null;
        const closures = await this.tenantPrisma.client.holiday.findMany({
          where: {
            date: { in: [today, tomorrow] },
            ...(campusId ? { OR: [{ campusId: null }, { campusId }] } : {}),
          },
          orderBy: { date: 'asc' },
        });
        for (const c of closures) {
          const when = c.date.getTime() === today.getTime() ? 'today' : 'tomorrow';
          out.push({
            id: `closed:${c.id}`,
            kind: 'SCHOOL_CLOSED',
            severity: 'info',
            at: c.date.toISOString(),
            knownAt: c.createdAt.toISOString(),
            text: `School is closed ${when} — ${c.name}.`,
            href: '/calendar',
          });
        }
      }),

      attempt(NEEDS.salaries, async () => {
        // Approved payslips nobody has recorded as paid — the accountant's payday list. Their OWN payslip is not
        // counted for them: they cannot mark it, so it is not theirs to act on.
        const campusId = restrictedCampusId(this.ctx.user);
        const unpaid = await this.db.payslip.count({
          where: {
            paidAt: null,
            run: { status: PayrollRunStatus.APPROVED, ...(campusId ? { campusId } : {}) },
            ...(this.ctx.user ? { staff: { userId: { not: this.ctx.user.userId } } } : {}),
          },
        });
        if (unpaid === 0) return;
        out.push({ id: `salaries-to-pay:${unpaid}`, kind: 'SALARIES_TO_PAY', severity: 'warn', at,
          text: `${unpaid} approved ${plural(unpaid, 'salary', 'salaries')} not yet paid.`, href: '/payroll' });
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
   * Cover, both ways (Cover Plan §5, C2).
   *
   * **The substitute is told they have a class**, because nothing else tells them: cover is
   * arranged by the office, on a screen the teacher cannot open, and a grant nobody mentions is a
   * grant nobody uses. **The absent teacher is told who took theirs**, because being covered in
   * silence is how staff learn to distrust a system — and because they are the one person who can
   * say "that is not my class" if the office picked the wrong section.
   *
   * Derived from the `CoverAssignment` rows themselves, so both items vanish the moment the cover
   * is removed — the rule that makes a derived feed trustworthy.
   *
   * Today only. Tomorrow's cover is not news yet, and yesterday's is history.
   */
  private async coverToday(staffId: string): Promise<NotificationItem[]> {
    const today = new Date(new Date().toISOString().slice(0, 10));
    const { covering, covered } = await this.cover.mineFor(staffId, today);
    const where = (c: { periodNo: number | null; section: { name: string; class: { name: string } } }) =>
      `${c.section.class.name}-${c.section.name}${c.periodNo ? ` period ${c.periodNo}` : ''}`;

    return [
      ...covering.map((c) => ({
        id: `covering:${c.id}`,
        kind: 'COVERING_TODAY' as const,
        // Not a warning: it is a fact about their day, and the action attached to it is one they
        // would want anyway. Warnings are for things that are going wrong.
        severity: 'info' as const,
        text: `You are covering ${where(c)} today${c.absentStaff ? ` for ${c.absentStaff.fullName ?? c.absentStaff.employeeCode}` : ''}.`,
        // Straight to the register that now works — the whole point of the grant.
        href: `/attendance?sectionId=${c.sectionId}`,
        at: c.createdAt.toISOString(),
      })),
      ...covered.map((c) => ({
        id: `covered:${c.id}`,
        kind: 'COVERED_TODAY' as const,
        severity: 'info' as const,
        text: `${c.coveringStaff.fullName ?? c.coveringStaff.employeeCode} is covering your ${where(c)} today.`,
        href: '/my-timetable',
        at: c.createdAt.toISOString(),
      })),
    ];
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
  private async registerUnmarked(): Promise<NotificationItem[]> {
    const { due, markByTime, sections } = await this.attendance.myUnmarkedToday();
    // Silent until the school's own deadline: before it, a blank register is a lesson that has not
    // happened yet, and complaining then teaches people to ignore the complaint.
    if (!due || sections.length === 0) return [];

    const today = new Date().toISOString().slice(0, 10);
    return [{
      // Dated, so it is a fresh reminder each day rather than one that never goes away.
      id: `register:${today}`,
      kind: 'REGISTER_UNMARKED' as const,
      severity: 'warn' as const,
      // ONE line a day, not one per section. G3 built this list for the head teacher, who needed to
      // see which classes were behind; aimed at the individual it would read as nagging, and G3's
      // rule was *surface, don't police*. The teacher's HOME names them instead — that is an
      // answer to "what do I do now", which is a different question from a reminder.
      text: sections.length === 1
        ? 'One of your registers is not marked yet today.'
        : `${sections.length} of your registers are not marked yet today.`,
      href: '/home',
      // The deadline itself, not "now" — so the item does not appear to move every time it is read.
      at: new Date(`${today}T${markByTime}:00.000Z`).toISOString(),
    }];
  }
}

/** Midnight UTC for a date, matching how `@db.Date` columns compare. */
function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
