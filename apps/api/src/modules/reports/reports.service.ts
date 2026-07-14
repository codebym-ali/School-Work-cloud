import { Injectable } from '@nestjs/common';
import { effectiveCampusFilter, PdfService, restrictedCampusId, TenantContext } from '@common';
import { TenantPrismaService } from '@database';

type Row = Record<string, unknown>;

/**
 * The seven reports (blueprint §28). Each returns an array of flat rows; the
 * controller renders them as JSON or CSV (PDF export is deferred). Reads are
 * tenant-scoped via RLS + the extension (no explicit schoolId needed for reads).
 * Campus-bound users are additionally confined to their own campus (§22.8, P1.7):
 * cross-campus rows simply don't appear (deny-by-default). `smsUsage` has no campus
 * dimension, so it stays school-wide.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly pdfSvc: PdfService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  /** Render any report's rows as a PDF (blueprint §28). Columns are the row keys. */
  async pdf(title: string, rows: Row[]): Promise<Buffer> {
    const school = await this.db.school.findFirst({ where: { id: this.ctx.requireSchoolId() }, select: { name: true } });
    return this.pdfSvc.table({
      schoolName: school?.name ?? 'School',
      title,
      generatedOn: new Date().toISOString().slice(0, 10),
      columns: rows.length > 0 ? Object.keys(rows[0]) : [],
      rows,
    });
  }

  /** `{ enrollment: { campusId } }` fragment for a campus-bound user, else `{}`. */
  private get campusEnrollmentFilter(): { enrollment: { campusId: string } } | Record<string, never> {
    const restricted = restrictedCampusId(this.ctx.user);
    return restricted ? { enrollment: { campusId: restricted } } : {};
  }

  async dailyCollection(date: string): Promise<Row[]> {
    const day = new Date(date);
    const next = new Date(day.getTime() + 86400000);
    const restricted = restrictedCampusId(this.ctx.user);
    const payments = await this.db.feePayment.findMany({
      where: {
        paidAt: { gte: day, lt: next },
        ...(restricted ? { invoice: { enrollment: { campusId: restricted } } } : {}),
      },
      orderBy: { receiptNo: 'asc' },
    });
    return payments.map((p) => ({ receiptNo: p.receiptNo, amountPaid: Number(p.amountPaid), method: p.method, transactionRef: p.transactionRef, paidAt: p.paidAt }));
  }

  async feeLedger(studentId: string): Promise<Row[]> {
    const invoices = await this.db.feeInvoice.findMany({ where: { studentId, ...this.campusEnrollmentFilter }, include: { payments: true }, orderBy: { createdAt: 'asc' } });
    return invoices.map((i) => ({
      invoiceId: i.id, month: i.month, year: i.year, total: Number(i.totalAmount), paid: Number(i.paidAmount),
      status: i.status, dueDate: i.dueDate, payments: i.payments.length,
    }));
  }

  async attendanceRegister(sectionId: string, from: string, to: string): Promise<Row[]> {
    const restricted = restrictedCampusId(this.ctx.user);
    const records = await this.db.attendanceRecord.findMany({
      where: {
        enrollment: { sectionId, ...(restricted ? { campusId: restricted } : {}) },
        date: { gte: new Date(from), lte: new Date(to) },
      },
      orderBy: [{ date: 'asc' }],
    });
    return records.map((r) => ({ enrollmentId: r.enrollmentId, date: r.date, session: r.session, status: r.status }));
  }

  async classStrength(): Promise<Row[]> {
    const year = await this.db.academicYear.findFirst({ where: { isCurrent: true } });
    if (!year) return [];
    const restricted = restrictedCampusId(this.ctx.user);
    const grouped = await this.db.studentEnrollment.groupBy({
      by: ['classId', 'sectionId'],
      where: { academicYearId: year.id, status: 'ACTIVE', ...(restricted ? { campusId: restricted } : {}) },
      _count: { _all: true },
    });
    return grouped.map((g) => ({ classId: g.classId, sectionId: g.sectionId, activeStudents: g._count._all }));
  }

  async defaulters(campusId?: string, minDays = 0): Promise<Row[]> {
    const cutoff = new Date(Date.now() - minDays * 86400000);
    // Campus-bound users are forced to their own campus; the client value is used only school-wide.
    const eff = effectiveCampusFilter(this.ctx.user, campusId);
    const invoices = await this.db.feeInvoice.findMany({
      where: { status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] }, dueDate: { lt: cutoff }, ...(eff ? { enrollment: { campusId: eff } } : {}) },
      include: { student: { select: { fullName: true, grNumber: true } } },
    });
    const byStudent = new Map<string, Row & { outstanding: number }>();
    for (const inv of invoices) {
      const cur = (byStudent.get(inv.studentId) as (Row & { outstanding: number }) | undefined) ?? { studentId: inv.studentId, name: inv.student.fullName, grNumber: inv.student.grNumber, outstanding: 0 };
      cur.outstanding = Math.round((cur.outstanding + Number(inv.totalAmount) - Number(inv.paidAmount)) * 100) / 100;
      byStudent.set(inv.studentId, cur);
    }
    return [...byStudent.values()];
  }

  async examSummary(examId: string): Promise<Row[]> {
    const results = await this.db.examResult.findMany({ where: { examId, ...this.campusEnrollmentFilter }, include: { subject: { select: { name: true } } } });
    return results.map((r) => ({
      enrollmentId: r.enrollmentId, subject: r.subject.name,
      marksObtained: r.isAbsent ? 'ABS' : Number(r.marksObtained), totalMarks: Number(r.totalMarks), isAbsent: r.isAbsent,
    }));
  }

  async smsUsage(from?: string, to?: string): Promise<Row[]> {
    const where = from || to ? { createdAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {};
    const grouped = await this.db.smsLog.groupBy({ by: ['status'], where, _count: { _all: true }, _sum: { segments: true } });
    return grouped.map((g) => ({ status: g.status, count: g._count._all, segments: g._sum.segments ?? 0 }));
  }
}
