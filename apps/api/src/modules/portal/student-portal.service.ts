import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AppError,
  attendancePercentFromStatuses,
  ErrorCodes,
  monthlyPerformance,
  summarisePerformance,
  TenantContext,
} from '@common';
import { TenantPrismaService } from '@database';

const money = (n: number): number => Math.round(n * 100) / 100;

/**
 * Student self-service portal (blueprint §5, §28, permission matrix §23 — STUDENT column).
 * Strictly read-only and self-scoped: every query resolves the `Student` linked to the
 * logged-in user (`Student.userId`), so a student can only ever see their own data
 * (SelfGuard, §22.8). No relation to other students, staff, or admin data is reachable.
 */
@Injectable()
export class StudentPortalService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  /** Statuses that revoke portal access. SUSPENDED is deliberately absent — a suspended
   *  student keeps the portal (they still need to see the notice and their fees) and gets a
   *  banner instead; RESTRICTED is the opposite case, still attending but cut off here. */
  private static readonly PORTAL_BLOCKED = ['RESTRICTED', 'STRUCK_OFF', 'WITHDRAWN'] as const;

  /** The Student row for the logged-in STUDENT user, or 403 if the account isn't linked.
   *  Status is re-checked on every read so revoking access takes effect immediately rather
   *  than at the next login — an already-issued session must not outlive the restriction. */
  private async self() {
    const userId = this.ctx.user?.userId;
    const student = userId ? await this.db.student.findFirst({ where: { userId, deletedAt: null } }) : null;
    if (!student) throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'No student is linked to this account');
    if ((StudentPortalService.PORTAL_BLOCKED as readonly string[]).includes(student.status)) {
      throw new AppError(
        ErrorCodes.FORBIDDEN,
        HttpStatus.FORBIDDEN,
        'Your portal access has been restricted. Please contact the school office.',
      );
    }
    return student;
  }

  private enrollmentIds(studentId: string): Promise<Array<{ id: string }>> {
    return this.db.studentEnrollment.findMany({ where: { studentId }, select: { id: true } });
  }

  /**
   * "What changed for me" — the student's own notification list.
   *
   * ⚠️ **A SEPARATE implementation from the staff `/notifications`, and that is the design.** The
   * staff service resolves the caller's STAFF PROFILE and carries a hand-copied `NEEDS` map whose
   * own comment warns that "getting one wrong hands a teacher the whole school's figures". A
   * student is not a role with fewer items — they are a different audience entirely, and putting
   * them through that service would leave a child one mistaken gate away from the school's
   * finances. Here, `self()` makes cross-student access structurally impossible.
   *
   * ⚠️ **Derived, never stored** — the same rule as the staff bell. Each item is computed from the
   * record it describes, so when the cause disappears the notice does too, with nothing to clean up.
   *
   * ⚠️ **Fees are deliberately absent.** A child is not the person who pays, and "Rs 12,000
   * overdue" in front of a fourteen-year-old is pressure applied to the wrong human. The invoice is
   * on their Fees page if they look; it is not pushed at them.
   */
  async notifications() {
    const student = await this.self();
    const today = startOfUtcDay(new Date());
    const tomorrow = new Date(today.getTime() + 86_400_000);

    const enrollment = await this.db.studentEnrollment.findFirst({
      where: { studentId: student.id, status: 'ACTIVE' },
      select: { id: true, campusId: true },
    });

    // `knownAt` — see the note on the staff service's NotificationItem: a closure's `at` is the
    // day being described, which is in the FUTURE for "shut tomorrow", and newness has to be
    // judged on when the school declared it or the badge can never be cleared.
    const items: { id: string; kind: string; severity: 'info' | 'warn'; at: string; knownAt?: string; text: string; href: string }[] = [];

    // ── The school is shut ────────────────────────────────────────────────────
    // ⚠️ Campus-scoped: `campusId: null` is the whole school, and a closure at one campus must not
    // tell a child at the other one to stay home.
    const closures = await this.db.holiday.findMany({
      where: {
        date: { in: [today, tomorrow] },
        ...(enrollment?.campusId ? { OR: [{ campusId: null }, { campusId: enrollment.campusId }] } : {}),
      },
      orderBy: { date: 'asc' },
    });
    for (const c of closures) {
      const when = c.date.getTime() === today.getTime() ? 'today' : 'tomorrow';
      items.push({
        id: `closed:${c.id}`, kind: 'SCHOOL_CLOSED', severity: 'info',
        at: c.date.toISOString(), knownAt: c.createdAt.toISOString(),
        text: `School is closed ${when} — ${c.name}.`, href: '/',
      });
    }

    // ── You were marked absent ────────────────────────────────────────────────
    // ⚠️ Recent only. This exists so a WRONG mark gets challenged while the register can still be
    // corrected; a month-old absence is history, and listing it just makes the bell noisy.
    if (enrollment) {
      const since = new Date(today.getTime() - 7 * 86_400_000);
      const absences = await this.db.attendanceRecord.findMany({
        where: { enrollmentId: enrollment.id, status: 'ABSENT', date: { gte: since } },
        orderBy: { date: 'desc' },
        take: 5,
      });
      for (const a of absences) {
        items.push({
          id: `absent:${a.id}`, kind: 'MARKED_ABSENT', severity: 'warn',
          at: a.date.toISOString(),
          text: `You were marked absent on ${dayMonth(a.date)}. Tell the office if that is wrong.`,
          href: '/attendance',
        });
      }
    }

    // ── Your leave was decided ────────────────────────────────────────────────
    const leaves = await this.db.studentLeave.findMany({
      where: { studentId: student.id, status: { in: ['APPROVED', 'REJECTED'] }, decidedAt: { gte: new Date(today.getTime() - 14 * 86_400_000) } },
      orderBy: { decidedAt: 'desc' },
      take: 5,
    });
    for (const l of leaves) {
      items.push({
        id: `leave:${l.id}:${l.status}`, kind: 'LEAVE_DECIDED',
        severity: l.status === 'APPROVED' ? 'info' : 'warn',
        at: (l.decidedAt ?? new Date()).toISOString(),
        text: `Your leave request was ${l.status.toLowerCase()}.`,
        href: '/attendance',
      });
    }

    const seenAt = (await this.db.user.findFirst({
      where: { id: this.ctx.user!.userId }, select: { notificationsSeenAt: true },
    }))?.notificationsSeenAt;

    items.sort((a, b) => (a.at < b.at ? 1 : -1));
    // Everything counts as new until they have looked — the same rule as the staff bell, so the
    // number on the badge and the list behind it can never disagree.
    const withNew = items.map(({ knownAt, ...i }) => ({
      ...i,
      isNew: seenAt ? new Date(knownAt ?? i.at) > seenAt : true,
    }));
    return { items: withNew, unread: withNew.filter((i) => i.isNew).length };
  }

  /** "I have looked." Records the visit against the caller and nobody else — no id is accepted. */
  async markNotificationsSeen() {
    await this.self();
    await this.db.user.update({
      where: { id: this.ctx.user!.userId },
      data: { notificationsSeenAt: new Date() },
    });
    return { ok: true };
  }

  async overview() {
    const student = await this.self();
    const [enrollment, guardians, invoices, enrolls] = await Promise.all([
      this.db.studentEnrollment.findFirst({
        where: { studentId: student.id, status: 'ACTIVE' },
        include: { section: { include: { class: { select: { name: true } } } }, academicYear: { select: { name: true } } },
        orderBy: { startedAt: 'desc' },
      }),
      this.db.studentGuardian.findMany({
        where: { studentId: student.id },
        include: { parent: { select: { fullName: true, phone: true } } },
        orderBy: { isPrimary: 'desc' },
      }),
      this.db.feeInvoice.findMany({ where: { studentId: student.id }, select: { totalAmount: true, paidAmount: true } }),
      this.enrollmentIds(student.id),
    ]);

    const outstandingFees = money(invoices.reduce((s, i) => s + (Number(i.totalAmount) - Number(i.paidAmount)), 0));

    const records = await this.db.attendanceRecord.findMany({
      where: { enrollmentId: { in: enrolls.map((e) => e.id) } },
      select: { status: true },
    });
    const attendancePercent = attendancePercentFromStatuses(records.map((r) => r.status));

    const reportCards = await this.db.reportCard.count({ where: { enrollmentId: { in: enrolls.map((e) => e.id) } } });

    return {
      student: {
        fullName: student.fullName, grNumber: student.grNumber, gender: student.gender, dateOfBirth: student.dateOfBirth,
        // Drives the dashboard banner — a suspended student can still sign in and must be
        // told why, along with the reason and the date it lifts.
        status: student.status,
        statusReason: student.statusReason,
        statusEndsOn: student.statusEndsOn,
      },
      enrollment: enrollment
        ? { className: enrollment.section.class.name, sectionName: enrollment.section.name, rollNumber: enrollment.rollNumber, year: enrollment.academicYear.name }
        : null,
      guardians: guardians.map((g) => ({ name: g.parent.fullName, phone: g.parent.phone, relation: g.relation, isPrimary: g.isPrimary })),
      attendancePercent,
      outstandingFees,
      reportCards,
    };
  }

  async attendance() {
    const student = await this.self();
    const enrolls = await this.enrollmentIds(student.id);
    return this.db.attendanceRecord.findMany({
      where: { enrollmentId: { in: enrolls.map((e) => e.id) } },
      orderBy: [{ date: 'desc' }],
      take: 60,
      select: { date: true, session: true, status: true },
    });
  }

  /**
   * Attendance with the counts already worked out — "how many days was I absent?" is the
   * question, and making a student tally 60 rows to answer it is not an answer.
   */
  async attendanceSummary(days = 30) {
    const student = await this.self();
    const enrolls = await this.enrollmentIds(student.id);
    const from = new Date(Date.now() - days * 86400000);

    const records = await this.db.attendanceRecord.findMany({
      where: { enrollmentId: { in: enrolls.map((e) => e.id) }, date: { gte: from } },
      orderBy: [{ date: 'desc' }],
      select: { date: true, session: true, status: true },
    });

    const counts = { PRESENT: 0, ABSENT: 0, LATE: 0, HALF_DAY: 0, ON_LEAVE: 0 } as Record<string, number>;
    for (const r of records) counts[r.status] = (counts[r.status] ?? 0) + 1;

    return {
      days,
      // Same helper the teacher, parent SMS and staff views use — one child must never have
      // two different attendance percentages depending on which screen you open.
      percent: attendancePercentFromStatuses(records.map((r) => r.status)),
      counts,
      records,
    };
  }

  /**
   * Class-test performance, per subject — the operator asked for "each subject a tab, each test's
   * marks, and a monthly report".
   *
   * Deliberately NO class average and NO rank. A child seeing "24th of 30" is a pressure device,
   * not feedback; their own month-on-month trend is what they can act on. Comparison stays on the
   * staff side. (Operator agreed; see Key Decisions.)
   */
  async testPerformance() {
    const student = await this.self();
    const enrolls = await this.enrollmentIds(student.id);
    const enrollmentIds = enrolls.map((e) => e.id);

    const scores = await this.db.classTestScore.findMany({
      where: { enrollmentId: { in: enrollmentIds } },
      include: {
        classTest: {
          select: { id: true, name: true, testDate: true, totalMarks: true, subjectId: true, subject: { select: { name: true } } },
        },
      },
      orderBy: { classTest: { testDate: 'desc' } },
    });

    const bySubject = new Map<string, { subjectId: string; subjectName: string; rows: typeof scores }>();
    for (const s of scores) {
      const key = s.classTest.subjectId;
      const bucket = bySubject.get(key);
      if (bucket) bucket.rows.push(s);
      else bySubject.set(key, { subjectId: key, subjectName: s.classTest.subject?.name ?? '—', rows: [s] });
    }

    const subjects = [...bySubject.values()].map(({ subjectId, subjectName, rows }) => {
      const shaped = rows.map((r) => ({
        marksObtained: r.marksObtained == null ? null : Number(r.marksObtained),
        totalMarks: Number(r.classTest.totalMarks),
        isAbsent: r.isAbsent,
        testDate: r.classTest.testDate,
      }));
      return {
        subjectId,
        subjectName,
        summary: summarisePerformance(shaped),
        monthly: monthlyPerformance(shaped),
        tests: rows.map((r) => ({
          id: r.classTest.id,
          name: r.classTest.name,
          testDate: r.classTest.testDate,
          totalMarks: Number(r.classTest.totalMarks),
          marksObtained: r.marksObtained == null ? null : Number(r.marksObtained),
          isAbsent: r.isAbsent,
        })),
      };
    });
    subjects.sort((a, b) => a.subjectName.localeCompare(b.subjectName));

    const all = scores.map((r) => ({
      marksObtained: r.marksObtained == null ? null : Number(r.marksObtained),
      totalMarks: Number(r.classTest.totalMarks),
      isAbsent: r.isAbsent,
      testDate: r.classTest.testDate,
    }));

    return { overall: summarisePerformance(all), monthly: monthlyPerformance(all), subjects };
  }

  async results() {
    const student = await this.self();
    const enrolls = await this.enrollmentIds(student.id);
    const cards = await this.db.reportCard.findMany({
      where: { enrollmentId: { in: enrolls.map((e) => e.id) } },
      orderBy: { generatedAt: 'desc' },
    });
    // Resolve term names in one query (ReportCard carries termId only).
    const terms = await this.db.term.findMany({ where: { id: { in: [...new Set(cards.map((c) => c.termId))] } }, select: { id: true, name: true } });
    const termName = new Map(terms.map((t) => [t.id, t.name]));
    return cards.map((c) => ({
      term: termName.get(c.termId) ?? '—',
      overallPercent: Number(c.overallPercent),
      grade: c.gradeLabel,
      sectionRank: c.sectionRank,
    }));
  }

  async fees() {
    const student = await this.self();
    const invoices = await this.db.feeInvoice.findMany({
      where: { studentId: student.id },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      select: {
        id: true, month: true, year: true, totalAmount: true, paidAmount: true, status: true, dueDate: true,
        // The receipts, alongside the bill they belong to. "You owe 900" without "and here is
        // what you have already paid, receipt #41" is half an answer, and the half that starts
        // the phone call to the office.
        payments: {
          orderBy: { paidAt: 'desc' },
          select: {
            id: true, receiptNo: true, amountPaid: true, method: true, paidAt: true,
            reversal: { select: { id: true } },
          },
        },
      },
    });
    return invoices.map((i) => ({
      id: i.id,
      month: i.month,
      year: i.year,
      total: Number(i.totalAmount),
      paid: Number(i.paidAmount),
      remaining: money(Number(i.totalAmount) - Number(i.paidAmount)),
      status: i.status,
      dueDate: i.dueDate,
      payments: i.payments.map((p) => ({
        id: p.id,
        receiptNo: p.receiptNo,
        amount: Number(p.amountPaid),
        method: p.method,
        paidAt: p.paidAt,
        // Shown, not hidden: a family that was handed a receipt needs to know it was reversed,
        // and a payment that silently vanishes from the list is how a dispute starts.
        reversed: p.reversal !== null,
      })),
    }));
  }
}

/** Midnight UTC, matching how `@db.Date` columns compare. */
function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const dayMonth = (d: Date): string =>
  new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
