import { HttpStatus, Injectable } from '@nestjs/common';
import { FeeInvoiceStatus, Prisma } from '@prisma/client';
import {
  AppError,
  assertCampusAccess,
  AuditActions,
  effectiveCampusFilter,
  ErrorCodes,
  paginate,
  parseSchoolSettings,
  TenantContext,
  toSkipTake,
  type Paginated,
} from '@common';
import { AuditService, TenantPrismaService } from '@database';
import { AccessService } from '../access/access.service';
import { SetupService } from '../setup/setup.service';
import { PaymentsService } from './payments.service';
import type { CreateInvoiceBatchDto, DefaultersQuery, InvoiceListQuery, ReasonDto } from './dto/fees.dto';

const money = (n: number): number => Math.round(n * 100) / 100;

interface LineItem {
  type: 'FEE' | 'DISCOUNT';
  feeHeadId: string | null;
  description: string;
  amount: number; // negative for DISCOUNT
}

/** Invoicing (blueprint §12): idempotent batch generation, queries, waive, defaulters. */
@Injectable()
export class InvoicingService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly setup: SetupService,
    private readonly audit: AuditService,
    private readonly payments: PaymentsService,
    private readonly access: AccessService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }
  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  /**
   * Generate one invoice per ACTIVE enrollment in the class for (month, year).
   * Idempotent on the batch `[schoolId, classId, month, year]` (duplicate → existing
   * batch) and per-student (existing invoice for the month is skipped). Runs in the
   * request transaction. (Async batching is a later scale optimisation.)
   */
  async createBatch(dto: CreateInvoiceBatchDto) {
    await this.access.assert('fees.invoicing');
    // Campus scoping (§22.8, P1.7): a campus-bound admin may only bill their own campus.
    const klass = await this.db.class.findFirst({ where: { id: dto.classId }, select: { campusId: true } });
    if (!klass) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Class not found');
    assertCampusAccess(this.ctx.user, klass.campusId);

    const existing = await this.db.feeInvoiceBatch.findFirst({
      where: { classId: dto.classId, month: dto.month, year: dto.year },
    });
    if (existing) return { batch: existing, alreadyExists: true, generated: 0 };

    const academicYearId = await this.setup.requireCurrentYearId();
    const year = await this.db.academicYear.findFirst({ where: { id: academicYearId } });
    const annualMonth = year ? new Date(year.startDate).getUTCMonth() + 1 : 4;
    const settings = parseSchoolSettings((await this.school())?.settings ?? {});
    const dueDate = new Date(Date.UTC(dto.year, dto.month - 1, settings.feeDueDay));

    const batch = await this.db.feeInvoiceBatch.create({
      data: { schoolId: this.sid, classId: dto.classId, academicYearId, month: dto.month, year: dto.year, status: 'RUNNING', createdById: this.ctx.user!.userId },
    });

    const enrollments = await this.db.studentEnrollment.findMany({
      where: { classId: dto.classId, academicYearId, status: 'ACTIVE' },
    });
    const structures = await this.db.feeStructure.findMany({
      where: { classId: dto.classId, academicYearId, isActive: true },
      include: { feeHead: { select: { name: true } } },
    });

    let generated = 0;
    const newInvoiceIds: string[] = [];
    for (const enr of enrollments) {
      const dupe = await this.db.feeInvoice.findFirst({ where: { studentId: enr.studentId, month: dto.month, year: dto.year } });
      if (dupe) continue;

      const items: LineItem[] = [];
      for (const s of structures) {
        const applies = s.frequency === 'MONTHLY' || (s.frequency === 'ANNUAL' && dto.month === annualMonth);
        if (!applies) continue;
        items.push({ type: 'FEE', feeHeadId: s.feeHeadId, description: `${s.feeHead.name} (${s.frequency})`, amount: money(Number(s.amount)) });
      }
      if (items.length === 0) continue;

      for (const d of await this.discountItems(enr.studentId, items)) items.push(d);

      const total = money(items.reduce((sum, i) => sum + i.amount, 0));
      const created = await this.db.feeInvoice.create({
        data: {
          schoolId: this.sid,
          studentId: enr.studentId,
          enrollmentId: enr.id,
          batchId: batch.id,
          totalAmount: Math.max(total, 0),
          dueDate,
          status: FeeInvoiceStatus.PENDING,
          month: dto.month,
          year: dto.year,
          // schoolId is derived from the parent invoice's composite relation FK — omit it here.
          items: { create: items.map((i) => ({ type: i.type, feeHeadId: i.feeHeadId, description: i.description, amount: i.amount })) },
        },
      });
      newInvoiceIds.push(created.id);
      generated++;
    }

    // Auto-apply any available guardian advance to each newly-generated invoice (§12): a
    // fresh invoice consumes the primary guardian's standing credit (oldest new invoice
    // first; sibling invoices share the balance as it draws down).
    for (const invoiceId of newInvoiceIds) {
      await this.payments.applyAdvanceToInvoice(invoiceId);
    }

    await this.db.feeInvoiceBatch.update({ where: { id: batch.id }, data: { status: 'DONE' } });
    return { batch, alreadyExists: false, generated };
  }

  /** Active discounts for a student → negative line items (FIXED applied after PERCENT). */
  private async discountItems(studentId: string, feeItems: LineItem[]): Promise<LineItem[]> {
    const now = new Date();
    const discounts = await this.db.discount.findMany({
      where: {
        studentId,
        status: 'ACTIVE',
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gte: now } }],
      },
    });
    const out: LineItem[] = [];
    const feeTotalFor = (headId: string | null) =>
      feeItems.filter((i) => i.type === 'FEE' && (headId === null || i.feeHeadId === headId)).reduce((s, i) => s + i.amount, 0);

    // PERCENT first, then FIXED, capped at 100% of the target base.
    for (const kind of ['PERCENT', 'FIXED'] as const) {
      for (const d of discounts.filter((x) => x.type === kind)) {
        const base = feeTotalFor(d.feeHeadId ?? null);
        if (base <= 0) continue;
        const raw = d.type === 'PERCENT' ? (base * Number(d.value)) / 100 : Number(d.value);
        const amount = money(Math.min(raw, base));
        out.push({ type: 'DISCOUNT', feeHeadId: d.feeHeadId ?? null, description: `Discount (${d.reason})`, amount: -amount });
      }
    }
    return out;
  }

  async list(q: InvoiceListQuery): Promise<Paginated<unknown>> {
    const where: Prisma.FeeInvoiceWhereInput = {};
    if (q.studentId) where.studentId = q.studentId;
    if (q.status) where.status = q.status as FeeInvoiceStatus;
    if (q.month) where.month = q.month;
    if (q.year) where.year = q.year;
    // Campus scoping (§22.8, P1.7): force a campus-bound admin's campus, overriding the client's.
    const campusId = effectiveCampusFilter(this.ctx.user, q.campusId);
    if (campusId) where.enrollment = { campusId };
    const { skip, take } = toSkipTake(q);
    const [rows, total] = await Promise.all([
      this.db.feeInvoice.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.db.feeInvoice.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  async get(id: string) {
    const inv = await this.db.feeInvoice.findFirst({
      where: { id },
      include: { items: true, payments: true, enrollment: { select: { campusId: true } } },
    });
    if (!inv) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Invoice not found');
    // Campus scoping (§22.8, P1.7): a campus-bound admin may only read their campus's invoice.
    assertCampusAccess(this.ctx.user, inv.enrollment?.campusId ?? null);
    return inv;
  }

  /** Waiver zeroes the remaining balance via a WAIVER line item (OWNER_ADMIN, §12). */
  async waive(id: string, dto: ReasonDto) {
    const inv = await this.get(id);
    if (inv.status === FeeInvoiceStatus.WAIVED || inv.status === FeeInvoiceStatus.PAID) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, `Invoice is ${inv.status}`);
    }
    const remaining = money(Number(inv.totalAmount) - Number(inv.paidAmount));
    await this.db.feeInvoiceItem.create({
      data: { schoolId: this.sid, invoiceId: id, type: 'WAIVER', description: `Waiver (${dto.reason})`, amount: -remaining },
    });
    const updated = await this.db.feeInvoice.update({
      where: { id },
      data: { totalAmount: Number(inv.paidAmount), status: FeeInvoiceStatus.WAIVED },
    });
    await this.audit.record({ action: AuditActions.FEE_WAIVED, entityType: 'FeeInvoice', entityId: id, reason: dto.reason, oldValue: { remaining } });
    return updated;
  }

  async defaulters(q: DefaultersQuery) {
    const cutoff = new Date(Date.now() - (q.minDays ?? 0) * 86400000);
    const invoices = await this.db.feeInvoice.findMany({
      where: {
        status: { in: [FeeInvoiceStatus.PENDING, FeeInvoiceStatus.PARTIAL, FeeInvoiceStatus.OVERDUE] },
        dueDate: { lt: cutoff },
        ...(q.campusId ? { enrollment: { campusId: q.campusId } } : {}),
      },
      include: { student: { select: { id: true, fullName: true, grNumber: true } } },
    });
    const byStudent = new Map<string, { student: unknown; outstanding: number; invoices: number }>();
    for (const inv of invoices) {
      const key = inv.studentId;
      const cur = byStudent.get(key) ?? { student: inv.student, outstanding: 0, invoices: 0 };
      cur.outstanding = money(cur.outstanding + Number(inv.totalAmount) - Number(inv.paidAmount));
      cur.invoices += 1;
      byStudent.set(key, cur);
    }
    return [...byStudent.values()].sort((a, b) => b.outstanding - a.outstanding);
  }

  private school() {
    return this.db.school.findFirst({ where: { id: this.sid } });
  }
}
