import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '@database';

type Row = Record<string, unknown>;

/**
 * The seven reports (blueprint §28). Each returns an array of flat rows; the
 * controller renders them as JSON or CSV (PDF export is deferred). Reads are
 * tenant-scoped via RLS + the extension (no explicit schoolId needed for reads).
 */
@Injectable()
export class ReportsService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  async dailyCollection(date: string): Promise<Row[]> {
    const day = new Date(date);
    const next = new Date(day.getTime() + 86400000);
    const payments = await this.db.feePayment.findMany({
      where: { paidAt: { gte: day, lt: next } },
      orderBy: { receiptNo: 'asc' },
    });
    return payments.map((p) => ({ receiptNo: p.receiptNo, amountPaid: Number(p.amountPaid), method: p.method, transactionRef: p.transactionRef, paidAt: p.paidAt }));
  }

  async feeLedger(studentId: string): Promise<Row[]> {
    const invoices = await this.db.feeInvoice.findMany({ where: { studentId }, include: { payments: true }, orderBy: { createdAt: 'asc' } });
    return invoices.map((i) => ({
      invoiceId: i.id, month: i.month, year: i.year, total: Number(i.totalAmount), paid: Number(i.paidAmount),
      status: i.status, dueDate: i.dueDate, payments: i.payments.length,
    }));
  }

  async attendanceRegister(sectionId: string, from: string, to: string): Promise<Row[]> {
    const records = await this.db.attendanceRecord.findMany({
      where: { enrollment: { sectionId }, date: { gte: new Date(from), lte: new Date(to) } },
      orderBy: [{ date: 'asc' }],
    });
    return records.map((r) => ({ enrollmentId: r.enrollmentId, date: r.date, session: r.session, status: r.status }));
  }

  async classStrength(): Promise<Row[]> {
    const year = await this.db.academicYear.findFirst({ where: { isCurrent: true } });
    if (!year) return [];
    const grouped = await this.db.studentEnrollment.groupBy({
      by: ['classId', 'sectionId'],
      where: { academicYearId: year.id, status: 'ACTIVE' },
      _count: { _all: true },
    });
    return grouped.map((g) => ({ classId: g.classId, sectionId: g.sectionId, activeStudents: g._count._all }));
  }

  async defaulters(campusId?: string, minDays = 0): Promise<Row[]> {
    const cutoff = new Date(Date.now() - minDays * 86400000);
    const invoices = await this.db.feeInvoice.findMany({
      where: { status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] }, dueDate: { lt: cutoff }, ...(campusId ? { enrollment: { campusId } } : {}) },
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
    const results = await this.db.examResult.findMany({ where: { examId }, include: { subject: { select: { name: true } } } });
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
