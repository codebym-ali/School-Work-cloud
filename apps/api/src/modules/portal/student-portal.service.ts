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
      select: { id: true, month: true, year: true, totalAmount: true, paidAmount: true, status: true, dueDate: true },
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
    }));
  }
}
