import { Injectable } from '@nestjs/common';
import { effectiveCampusFilter, PdfService, restrictedCampusId, TenantContext } from '@common';
import { TenantPrismaService } from '@database';

type Row = Record<string, unknown>;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
      include: { invoice: { select: { student: { select: { fullName: true, grNumber: true } } } } },
      orderBy: { receiptNo: 'asc' },
    });
    // Who paid, not only a receipt number — a collection sheet the cashier cannot reconcile by name is half a sheet.
    return payments.map((p) => ({
      receiptNo: p.receiptNo, student: p.invoice.student.fullName, grNumber: p.invoice.student.grNumber,
      amountPaid: Number(p.amountPaid), method: p.method, transactionRef: p.transactionRef, paidAt: p.paidAt,
    }));
  }

  async feeLedger(studentId: string): Promise<Row[]> {
    const invoices = await this.db.feeInvoice.findMany({ where: { studentId, ...this.campusEnrollmentFilter }, include: { payments: true }, orderBy: { createdAt: 'asc' } });
    return invoices.map((i) => ({
      // "Aug 2026", as the challan and the parent say it — not "8/2026".
      period: i.month ? `${MONTHS[i.month - 1]} ${i.year}` : String(i.year), total: Number(i.totalAmount), paid: Number(i.paidAmount),
      balance: Math.max(Math.round((Number(i.totalAmount) - Number(i.paidAmount)) * 100) / 100, 0),
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
      include: { enrollment: { select: { rollNumber: true, student: { select: { fullName: true, grNumber: true } } } } },
      orderBy: [{ date: 'asc' }],
    });
    return records.map((r) => ({
      date: r.date, student: r.enrollment.student.fullName, grNumber: r.enrollment.student.grNumber,
      roll: r.enrollment.rollNumber, session: r.session, status: r.status,
    }));
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
    // Names, not ids, ordered as the school orders its classes. The ids alone made this — the report an owner
    // reads every term — a table of UUIDs.
    const [classes, sections] = await Promise.all([
      this.db.class.findMany({ where: { id: { in: [...new Set(grouped.map((g) => g.classId))] } }, select: { id: true, name: true, order: true } }),
      this.db.section.findMany({ where: { id: { in: [...new Set(grouped.map((g) => g.sectionId))] } }, select: { id: true, name: true } }),
    ]);
    const cls = new Map(classes.map((c) => [c.id, c]));
    const sec = new Map(sections.map((s) => [s.id, s.name]));
    return grouped
      .map((g) => ({ order: cls.get(g.classId)?.order ?? 0, class: cls.get(g.classId)?.name ?? '—', section: sec.get(g.sectionId) ?? '—', activeStudents: g._count._all }))
      .sort((a, b) => a.order - b.order || a.section.localeCompare(b.section))
      .map(({ order: _order, ...row }) => row);
  }

  async defaulters(campusId?: string, minDays = 0): Promise<Row[]> {
    const cutoff = new Date(Date.now() - minDays * 86400000);
    // Campus-bound users are forced to their own campus; the client value is used only school-wide.
    const eff = effectiveCampusFilter(this.ctx.user, campusId);
    const invoices = await this.db.feeInvoice.findMany({
      where: { status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] }, dueDate: { lt: cutoff }, ...(eff ? { enrollment: { campusId: eff } } : {}) },
      include: {
        student: { select: { fullName: true, grNumber: true } },
        enrollment: { select: { class: { select: { name: true } }, section: { select: { name: true } } } },
      },
      orderBy: { dueDate: 'asc' },
    });
    type Defaulter = Row & { outstanding: number; invoices: number; oldestDue: Date };
    const byStudent = new Map<string, Defaulter>();
    for (const inv of invoices) {
      // The class the bill was raised in — "Grade 6 — A" is how the office finds the family.
      const cur = byStudent.get(inv.studentId) ?? {
        name: inv.student.fullName, grNumber: inv.student.grNumber,
        class: `${inv.enrollment.class.name} — ${inv.enrollment.section.name}`,
        outstanding: 0, invoices: 0, oldestDue: inv.dueDate,
      };
      cur.outstanding = Math.round((cur.outstanding + Number(inv.totalAmount) - Number(inv.paidAmount)) * 100) / 100;
      cur.invoices += 1;
      byStudent.set(inv.studentId, cur);
    }
    // Who owes most first — "who owes fees and how much?" is answered at the top of the list, not by sorting it.
    return [...byStudent.values()].sort((a, b) => b.outstanding - a.outstanding || String(a.name).localeCompare(String(b.name)));
  }

  async examSummary(examId: string): Promise<Row[]> {
    const results = await this.db.examResult.findMany({
      where: { examId, ...this.campusEnrollmentFilter },
      include: { subject: { select: { name: true } }, enrollment: { select: { student: { select: { fullName: true, grNumber: true } } } } },
    });
    return results
      .map((r) => ({
        student: r.enrollment.student.fullName, grNumber: r.enrollment.student.grNumber, subject: r.subject.name,
        marksObtained: r.isAbsent ? 'ABS' : Number(r.marksObtained), totalMarks: Number(r.totalMarks),
      }))
      .sort((a, b) => a.student.localeCompare(b.student) || a.subject.localeCompare(b.subject));
  }

  // ── Report pickers ───────────────────────────────────────────────────────────
  /**
   * Students by name or GR number, for the fee-ledger picker. At least two characters: a one-letter search
   * matches most of the school and is not a search. Name matching uses the `students_full_name_trgm` GIN
   * index (ILIKE is index-backed with pg_trgm), so it stays an index lookup as the school grows. Includes
   * students who have left — a fee ledger is most often wanted for exactly them.
   */
  async lookupStudents(q: string) {
    const term = q.trim();
    if (term.length < 2) return [];
    const restricted = restrictedCampusId(this.ctx.user);
    const rows = await this.db.student.findMany({
      where: {
        deletedAt: null,
        OR: [{ fullName: { contains: term, mode: 'insensitive' } }, { grNumber: { startsWith: term, mode: 'insensitive' } }],
        ...(restricted ? { enrollments: { some: { campusId: restricted } } } : {}),
      },
      select: {
        id: true, fullName: true, grNumber: true, isActive: true,
        enrollments: { orderBy: { startedAt: 'desc' }, take: 1, select: { class: { select: { name: true } }, section: { select: { name: true } } } },
      },
      orderBy: { fullName: 'asc' },
      take: 20,
    });
    return rows.map((s) => ({
      id: s.id, fullName: s.fullName, grNumber: s.grNumber, isActive: s.isActive,
      placement: s.enrollments[0] ? `${s.enrollments[0].class.name} ${s.enrollments[0].section.name}` : null,
    }));
  }

  async lookupSections() {
    const restricted = restrictedCampusId(this.ctx.user);
    const rows = await this.db.section.findMany({
      where: restricted ? { class: { campusId: restricted } } : {},
      select: { id: true, name: true, class: { select: { name: true, order: true, campus: { select: { name: true } } } } },
    });
    return rows
      .sort((a, b) => a.class.campus.name.localeCompare(b.class.campus.name) || a.class.order - b.class.order || a.name.localeCompare(b.name))
      .map((s) => ({ id: s.id, label: `${s.class.name} ${s.name}`, campus: s.class.campus.name }));
  }

  async lookupExams() {
    const restricted = restrictedCampusId(this.ctx.user);
    const rows = await this.db.examDefinition.findMany({
      where: restricted ? { class: { campusId: restricted } } : {},
      select: { id: true, name: true, class: { select: { name: true, order: true } }, term: { select: { name: true } } },
    });
    return rows
      .sort((a, b) => a.class.order - b.class.order || a.name.localeCompare(b.name))
      .map((e) => ({ id: e.id, label: `${e.name} — ${e.class.name}`, term: e.term.name }));
  }

  async smsUsage(from?: string, to?: string): Promise<Row[]> {
    const where = from || to ? { createdAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {};
    const grouped = await this.db.smsLog.groupBy({ by: ['status'], where, _count: { _all: true }, _sum: { segments: true } });
    return grouped.map((g) => ({ status: g.status, count: g._count._all, segments: g._sum.segments ?? 0 }));
  }
}
