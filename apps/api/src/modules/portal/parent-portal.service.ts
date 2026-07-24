import { HttpStatus, Injectable } from '@nestjs/common';
import { AppError, attendancePercentFromStatuses, ErrorCodes, TenantContext } from '@common';
import { TenantPrismaService } from '@database';

const money = (n: number): number => Math.round(n * 100) / 100;

/**
 * Parent self-service portal (blueprint §5, §28, permission matrix §23 — PARENT column).
 * Read-only and guardian-scoped: every query resolves the caller's children through the
 * `StudentGuardian` link (`parent.userId === logged-in user`). A parent can only ever read
 * their own children's data — any `studentId` that isn't theirs is 403'd (GuardianOfStudent,
 * §22.8, P1.7). Mirrors the STUDENT portal but keyed on the guardian instead of self.
 */
@Injectable()
export class ParentPortalService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  private get userId(): string {
    const uid = this.ctx.user?.userId;
    if (!uid) throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Not authenticated');
    return uid;
  }

  /** Assert the logged-in parent is a guardian of `studentId`; returns the student or 403. */
  private async assertGuardian(studentId: string) {
    const link = await this.db.studentGuardian.findFirst({
      where: { studentId, parent: { userId: this.userId } },
      include: { student: true },
    });
    if (!link || link.student.deletedAt) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Not a guardian of this student');
    }
    return link.student;
  }

  private async enrollmentIds(studentId: string): Promise<string[]> {
    const rows = await this.db.studentEnrollment.findMany({ where: { studentId }, select: { id: true } });
    return rows.map((e) => e.id);
  }

  private async attendancePercent(studentId: string): Promise<number | null> {
    const enrolls = await this.enrollmentIds(studentId);
    if (!enrolls.length) return null;
    const records = await this.db.attendanceRecord.findMany({
      where: { enrollmentId: { in: enrolls } },
      select: { status: true },
    });
    return attendancePercentFromStatuses(records.map((r) => r.status));
  }

  private async outstandingFees(studentId: string): Promise<number> {
    const invoices = await this.db.feeInvoice.findMany({
      where: { studentId },
      select: { totalAmount: true, paidAmount: true },
    });
    return money(invoices.reduce((s, i) => s + (Number(i.totalAmount) - Number(i.paidAmount)), 0));
  }

  /** The parent's children — one card each, enough to drive the portal landing. */
  async children() {
    const links = await this.db.studentGuardian.findMany({
      where: { parent: { userId: this.userId }, student: { deletedAt: null } },
      include: {
        student: {
          include: {
            enrollments: {
              where: { status: 'ACTIVE' },
              include: { section: { include: { class: { select: { name: true } } } } },
              orderBy: { startedAt: 'desc' },
              take: 1,
            },
          },
        },
      },
      orderBy: { isPrimary: 'desc' },
    });

    return Promise.all(
      links.map(async (l) => {
        const s = l.student;
        const enrollment = s.enrollments[0] ?? null;
        return {
          studentId: s.id,
          fullName: s.fullName,
          grNumber: s.grNumber,
          registrationNo: s.registrationNo,
          relation: l.relation,
          isPrimary: l.isPrimary,
          className: enrollment?.section.class.name ?? null,
          sectionName: enrollment?.section.name ?? null,
          rollNumber: enrollment?.rollNumber ?? null,
          attendancePercent: await this.attendancePercent(s.id),
          outstandingFees: await this.outstandingFees(s.id),
        };
      }),
    );
  }

  async overview(studentId: string) {
    const student = await this.assertGuardian(studentId);
    const [enrollment, guardians, reportCards] = await Promise.all([
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
      this.enrollmentIds(student.id).then((ids) => this.db.reportCard.count({ where: { enrollmentId: { in: ids } } })),
    ]);

    return {
      student: { fullName: student.fullName, grNumber: student.grNumber, registrationNo: student.registrationNo, gender: student.gender, dateOfBirth: student.dateOfBirth },
      enrollment: enrollment
        ? { className: enrollment.section.class.name, sectionName: enrollment.section.name, rollNumber: enrollment.rollNumber, year: enrollment.academicYear.name }
        : null,
      guardians: guardians.map((g) => ({ name: g.parent.fullName, phone: g.parent.phone, relation: g.relation, isPrimary: g.isPrimary })),
      attendancePercent: await this.attendancePercent(student.id),
      outstandingFees: await this.outstandingFees(student.id),
      reportCards,
    };
  }

  async attendance(studentId: string) {
    await this.assertGuardian(studentId);
    const enrolls = await this.enrollmentIds(studentId);
    return this.db.attendanceRecord.findMany({
      where: { enrollmentId: { in: enrolls } },
      orderBy: [{ date: 'desc' }],
      take: 60,
      select: { date: true, session: true, status: true },
    });
  }

  async results(studentId: string) {
    await this.assertGuardian(studentId);
    const enrolls = await this.enrollmentIds(studentId);
    const cards = await this.db.reportCard.findMany({
      where: { enrollmentId: { in: enrolls } },
      orderBy: { generatedAt: 'desc' },
    });
    const terms = await this.db.term.findMany({ where: { id: { in: [...new Set(cards.map((c) => c.termId))] } }, select: { id: true, name: true } });
    const termName = new Map(terms.map((t) => [t.id, t.name]));
    return cards.map((c) => ({
      term: termName.get(c.termId) ?? '—',
      overallPercent: Number(c.overallPercent),
      grade: c.gradeLabel,
      sectionRank: c.sectionRank,
    }));
  }

  async fees(studentId: string) {
    await this.assertGuardian(studentId);
    const invoices = await this.db.feeInvoice.findMany({
      where: { studentId },
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
