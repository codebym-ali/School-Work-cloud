import { Injectable } from '@nestjs/common';
import { AttendanceStatus, LeaveStatus } from '@prisma/client';
import { isPastLocalTime, parseSchoolSettings, TenantContext } from '@common';
import { TenantPrismaService } from '@database';

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
  kind: 'LEAVE_DECIDED' | 'REGISTER_UNMARKED' | 'MARKED_ABSENT' | 'SALARY_PAID';
  severity: 'info' | 'warn';
  text: string;
  href: string;
  at: string;
};

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
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  async forCaller(): Promise<{ items: NotificationItem[]; unread: number }> {
    const user = this.ctx.user;
    if (!user) return { items: [], unread: 0 };

    // Everything here hangs off a staff profile. No profile ⇒ nothing to say ⇒ empty, quietly.
    const [staff, account] = await Promise.all([
      this.db.staffProfile.findFirst({ where: { userId: user.userId }, select: { id: true } }),
      this.db.user.findFirst({ where: { id: user.userId }, select: { notificationsSeenAt: true } }),
    ]);
    if (!staff) return { items: [], unread: 0 };

    const raw = (
      await Promise.all([
        this.leaveDecided(staff.id),
        this.markedAbsent(staff.id),
        this.salaryPaid(staff.id),
        user.roles.includes('TEACHER') ? this.registerUnmarked(staff.id) : Promise.resolve([]),
      ])
    ).flat();

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
