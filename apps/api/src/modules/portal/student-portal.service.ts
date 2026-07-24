import { HttpStatus, Injectable } from '@nestjs/common';
import { AppError, attendancePercentFromStatuses, ErrorCodes, TenantContext } from '@common';
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

  /** The Student row for the logged-in STUDENT user, or 403 if the account isn't linked. */
  private async self() {
    const userId = this.ctx.user?.userId;
    const student = userId ? await this.db.student.findFirst({ where: { userId, deletedAt: null } }) : null;
    if (!student) throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'No student is linked to this account');
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
      student: { fullName: student.fullName, grNumber: student.grNumber, gender: student.gender, dateOfBirth: student.dateOfBirth },
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
