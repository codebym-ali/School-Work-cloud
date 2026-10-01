import { HttpStatus, Injectable } from '@nestjs/common';
import { FeeInvoiceStatus, Prisma } from '@prisma/client';
import {
  AppError,
  assertCampusAccess,
  assertMayReadFees,
  AuditActions,
  effectiveCampusFilter,
  ErrorCodes,
  paginate,
  parseSchoolSettings,
  TenantContext,
  toSkipTake,
  type Paginated,
} from '@common';
import { createHash } from 'node:crypto';
import { AuditService, IdempotencyService, TenantPrismaService } from '@database';
import { AccessService } from '../access/access.service';
import { SetupService } from '../setup/setup.service';
import { SmsProducer } from '../comms/sms/sms-producer.service';
import { PaymentsService } from './payments.service';
import type { CreateInvoiceBatchDto, CreateStudentInvoiceDto, DefaultersQuery, InvoiceListQuery, ReasonDto } from './dto/fees.dto';

const hashOf = (parts: unknown): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

const money = (n: number): number => Math.round(n * 100) / 100;

interface LineItem {
  type: 'FEE' | 'DISCOUNT';
  feeHeadId: string | null;
  description: string;
  amount: number; // negative for DISCOUNT
}

/** Invoicing (blueprint §12): idempotent batch generation, queries, waive, defaulters. */
export interface DefaulterRow {
  student: { id: string; fullName: string; grNumber: string };
  outstanding: number;
  invoices: number;
  oldestDueDate: Date;
  daysOverdue: number;
  guardian: { name: string; relation: string; phone: string; canText: boolean } | null;
}

@Injectable()
export class InvoicingService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly setup: SetupService,
    private readonly audit: AuditService,
    private readonly payments: PaymentsService,
    private readonly access: AccessService,
    private readonly idempotency: IdempotencyService,
    private readonly sms: SmsProducer,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }
  private get sid(): string {
    return this.ctx.requireSchoolId();
  }
  /** The owner may choose not to show fees to a campus admin (`campusAdminSeesFees`). */
  private mayReadFees() {
    return assertMayReadFees(this.ctx.user, async () => (await this.db.school.findFirst({ where: { id: this.sid }, select: { settings: true } }))?.settings);
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
    if (existing) return { batch: existing, alreadyExists: true, generated: 0, pendingApproval: false as boolean, approvalId: null as string | null };

    const academicYearId = await this.setup.requireCurrentYearId();
    const year = await this.db.academicYear.findFirst({ where: { id: academicYearId } });
    const annualMonth = year ? new Date(year.startDate).getUTCMonth() + 1 : 4;
    const settings = parseSchoolSettings((await this.school())?.settings ?? {});
    // The owner signs off a campus's monthly vouchers (Approval Requests): office-generated invoices are created
    // as PENDING_APPROVAL — not issued, not payable, invisible to families — until the owner approves. The owner's
    // own batches are never held (they are the approver), and a school may switch the step off.
    const needsApproval = settings.feeVoucherApproval && !this.ctx.user!.roles.includes('OWNER_ADMIN') && !this.ctx.user!.roles.includes('OPERATIONS_ADMIN');
    const dueDate = new Date(Date.UTC(dto.year, dto.month - 1, settings.feeDueDay));

    const batch = await this.db.feeInvoiceBatch.create({
      data: { schoolId: this.sid, classId: dto.classId, academicYearId, month: dto.month, year: dto.year, status: 'RUNNING', createdById: this.ctx.user!.userId },
    });

    // `student: { deletedAt: null }` is belt-and-braces: softDelete now closes the enrollment,
    // but a removed student must never be billed even if an old ACTIVE row survives.
    const enrollments = await this.db.studentEnrollment.findMany({
      where: { classId: dto.classId, academicYearId, status: 'ACTIVE', student: { deletedAt: null } },
    });
    // The price IN FORCE for the month being billed. A school that raises tuition in January
    // has two rows for the same head; billing December must use December's price, so this
    // takes the latest row starting on or before the month — not simply "the" structure.
    const monthStart = new Date(Date.UTC(dto.year, dto.month - 1, 1));
    const structures = inForceStructures(
      await this.db.feeStructure.findMany({
        where: { classId: dto.classId, academicYearId, isActive: true, effectiveFrom: { lte: monthStart } },
        include: { feeHead: { select: { name: true } } },
        orderBy: { effectiveFrom: 'asc' },
      }),
    );

    let generated = 0;
    const newInvoiceIds: string[] = [];
    for (const enr of enrollments) {
      const dupe = await this.db.feeInvoice.findFirst({ where: { studentId: enr.studentId, month: dto.month, year: dto.year } });
      if (dupe) continue;

      const created = await this.buildInvoice({
        enrollment: enr, structures, annualMonth, dueDate,
        month: dto.month, year: dto.year, batchId: batch.id,
        academicYearId, siblingDiscountPercent: settings.siblingDiscountPercent,
        status: needsApproval ? FeeInvoiceStatus.PENDING_APPROVAL : FeeInvoiceStatus.PENDING,
      });
      if (!created) continue;
      newInvoiceIds.push(created.id);
      generated++;
    }

    // Auto-apply any available guardian advance to each newly-generated invoice (§12): a
    // fresh invoice consumes the primary guardian's standing credit (oldest new invoice
    // first; sibling invoices share the balance as it draws down).
    // ⚠️ Not for held invoices: a voucher nobody has been sent must not quietly spend a family's advance. The
    // approval does it at the moment the voucher is actually issued.
    if (!needsApproval) {
      for (const invoiceId of newInvoiceIds) {
        await this.payments.applyAdvanceToInvoice(invoiceId);
      }
    }

    await this.db.feeInvoiceBatch.update({ where: { id: batch.id }, data: { status: 'DONE' } });
    const approvalId = needsApproval && generated > 0 ? await this.requestVoucherApproval(klass.campusId, dto.month, dto.year) : null;
    return { batch, alreadyExists: false, generated, pendingApproval: needsApproval && generated > 0, approvalId };
  }

  /**
   * One PENDING approval per (campus, month, year): every class batch the office runs for that campus and month
   * lands on the same request, so the owner signs off "Gulberg · September" once, not once per class. Find-then-write
   * (no upsert on tenant models). The request only describes the batch; the PENDING_APPROVAL invoices are the truth.
   */
  private async requestVoucherApproval(campusId: string, month: number, year: number): Promise<string> {
    const open = await this.db.approvalRequest.findMany({ where: { type: 'VOUCHER_BATCH', status: 'PENDING', campusId } });
    const match = open.find((r) => {
      const p = r.payload as { month?: number; year?: number } | null;
      return p?.month === month && p?.year === year;
    });
    if (match) return match.id;
    const campus = await this.db.campus.findFirst({ where: { id: campusId }, select: { name: true } });
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const created = await this.db.approvalRequest.create({
      data: {
        schoolId: this.sid, type: 'VOUCHER_BATCH', campusId,
        title: `Fee vouchers · ${campus?.name ?? 'Campus'} · ${MONTHS[month - 1]} ${year}`,
        payload: { month, year }, requestedById: this.ctx.user!.userId,
      },
    });
    await this.audit.record({
      action: AuditActions.APPROVAL_REQUESTED, entityType: 'ApprovalRequest', entityId: created.id,
      newValue: { type: 'VOUCHER_BATCH', campusId, month, year },
    });
    return created.id;
  }

  /**
   * Invoice ONE student for one period (Fees Billing Plan, B1).
   *
   * ⚠️ **The gap this closes is not convenience.** Billing was batch-only, and a
   * (class, month, year) can be billed once ever — `createBatch` returns early on an existing
   * batch. So a child admitted *after* their class was billed could not be invoiced at all, and
   * mid-session admissions are normal. The cashier flow ("open the child, press generate, collect")
   * had no endpoint behind it either.
   *
   * Carries the same guards as the batch path — `fees.invoicing` and the campus check — because a
   * new write path that quietly drops a check the old one had is the defect this project keeps
   * finding. Idempotent, like `pay`: a cashier double-clicking must not bill twice, and the unique
   * index behind it (B0) is the backstop if the key is ever omitted.
   */
  async createForStudent(dto: CreateStudentInvoiceDto, idempotencyKey: string) {
    await this.access.assert('fees.invoicing');
    if (!idempotencyKey) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.BAD_REQUEST, 'Idempotency-Key header is required');
    }

    return this.idempotency.run(idempotencyKey, hashOf({ ...dto }), async () => {
      const academicYearId = await this.setup.requireCurrentYearId();

      // The ACTIVE enrolment is what says which class prices this student and which campus they
      // belong to — both of which the caller must not be trusted to supply.
      const enrollment = await this.db.studentEnrollment.findFirst({
        where: { studentId: dto.studentId, academicYearId, status: 'ACTIVE', student: { deletedAt: null } },
        select: { id: true, studentId: true, classId: true, campusId: true },
      });
      if (!enrollment) {
        throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'No active enrollment for this student');
      }
      assertCampusAccess(this.ctx.user, enrollment.campusId);

      const year = await this.db.academicYear.findFirst({ where: { id: academicYearId } });
      const annualMonth = year ? new Date(year.startDate).getUTCMonth() + 1 : 4;
      const settings = parseSchoolSettings((await this.school())?.settings ?? {});
      const dueDate = new Date(Date.UTC(dto.year, dto.month - 1, settings.feeDueDay));
      const monthStart = new Date(Date.UTC(dto.year, dto.month - 1, 1));

      const structures = inForceStructures(
        await this.db.feeStructure.findMany({
          where: { classId: enrollment.classId, academicYearId, isActive: true, effectiveFrom: { lte: monthStart } },
          include: { feeHead: { select: { name: true } } },
          orderBy: { effectiveFrom: 'asc' },
        }),
      );

      // batchId: null — this invoice belongs to no batch, which is exactly the case the old
      // partial unique index did not cover. B0 widened it before this path existed.
      const created = await this.buildInvoice({
        enrollment, structures, annualMonth, dueDate,
        month: dto.month, year: dto.year, batchId: null,
        academicYearId, siblingDiscountPercent: settings.siblingDiscountPercent,
      });
      if (!created) {
        throw new AppError(
          ErrorCodes.CONFLICT, HttpStatus.CONFLICT,
          'Nothing to invoice: this student already has an invoice for that period, or their class has no fees set.',
        );
      }

      await this.payments.applyAdvanceToInvoice(created.id);
      await this.audit.record({
        action: AuditActions.INVOICE_GENERATED,
        entityType: 'FeeInvoice',
        entityId: created.id,
        newValue: { studentId: dto.studentId, month: dto.month, year: dto.year, adHoc: true },
      });
      // `run` speaks {status, body} so a replayed key can return the ORIGINAL response verbatim.
      return { status: 201, body: { invoiceId: created.id } };
    });
  }

  /**
   * Price one student for one period and write the invoice — **the single pricing path.**
   *
   * Both the class batch and the per-student route (B1) come through here. A second copy would
   * drift: the effective-dated price lookup, the ANNUAL anchor month and the discount application
   * are three rules that must agree, and the one thing worse than billing wrongly is billing two
   * different ways depending on which button was pressed.
   *
   * Returns `null` when there is nothing to charge, so callers can skip rather than write an empty
   * invoice.
   */
  private async buildInvoice(args: {
    enrollment: { id: string; studentId: string };
    structures: readonly { feeHeadId: string; frequency: string; amount: Prisma.Decimal | number; feeHead: { name: string } }[];
    annualMonth: number;
    dueDate: Date;
    month: number;
    year: number;
    batchId: string | null;
    academicYearId: string;
    siblingDiscountPercent: number;
    /** PENDING_APPROVAL for an office-generated monthly batch awaiting the owner; defaults to issued (PENDING). */
    status?: FeeInvoiceStatus;
  }): Promise<{ id: string } | null> {
    const { enrollment, structures, annualMonth, dueDate, month, year, batchId } = args;

    const dupe = await this.db.feeInvoice.findFirst({ where: { studentId: enrollment.studentId, month, year } });
    if (dupe) return null;

    // Charge-once heads (B3) already billed on THIS enrolment. Read once rather than per structure.
    const alreadyCharged = await this.chargedOnceHeadIds(enrollment.id);

    const items: LineItem[] = [];
    for (const s of structures) {
      // ⚠️ **ADMISSION and ONE_TIME used to be silently skipped**, because the question asked was
      // "is it this month?" — which no one-off charge can ever answer. The admission fee, one of the
      // largest charges in a Pakistani private school, therefore could not be billed through the
      // system at all and was collected off-book, which is where a fee system loses its integrity.
      //
      // The right question is "has this student been charged it on this enrolment?" — a ledger
      // fact, not an inference from the calendar.
      const chargeOnce = s.frequency === 'ADMISSION' || s.frequency === 'ONE_TIME';
      const applies = chargeOnce
        ? !alreadyCharged.has(s.feeHeadId)
        : s.frequency === 'MONTHLY' || (s.frequency === 'ANNUAL' && month === annualMonth);
      if (!applies) continue;
      items.push({ type: 'FEE', feeHeadId: s.feeHeadId, description: `${s.feeHead.name} (${s.frequency})`, amount: money(Number(s.amount)) });
    }
    if (items.length === 0) return null;

    for (const d of await this.discountItems(enrollment.studentId, items)) items.push(d);

    // ── Sibling discount (B2) ─────────────────────────────────────────────────
    // `siblingDiscountPercent` had existed in the settings schema, the DTO, the API types AND the
    // settings screen while being read by **nothing**: an owner could set 20%, see a success toast,
    // and no invoice was ever a rupee cheaper. It silently overcharged families, and a school would
    // have learned of it from a parent rather than an error.
    //
    // ⚠️ Applied to the WHOLE fee subtotal, every head. The setting is a single percentage with no
    // head scope, so narrowing it to tuition here would be inventing a rule the operator never
    // configured. `Discount.feeHeadId` already supports per-head concessions if a school wants one.
    // **Assumed 2026-08-12; the alternative is a second setting, not a hidden default.**
    if (args.siblingDiscountPercent > 0) {
      const rank = await this.siblingRank(enrollment.studentId, args.academicYearId);
      if (rank >= 2) {
        const base = items.filter((i) => i.type === 'FEE').reduce((sum, i) => sum + i.amount, 0);
        if (base > 0) {
          const amount = money(Math.min((base * args.siblingDiscountPercent) / 100, base));
          // The reason is carried ON the invoice, which is what makes historising the SETTING
          // unnecessary: "why is this family's bill lower?" is answerable from the bill itself.
          items.push({
            type: 'DISCOUNT',
            feeHeadId: null,
            description: `Sibling discount (child ${rank}, ${args.siblingDiscountPercent}%)`,
            amount: -amount,
          });
        }
      }
    }

    const total = money(items.reduce((sum, i) => sum + i.amount, 0));
    return this.db.feeInvoice.create({
      data: {
        schoolId: this.sid,
        studentId: enrollment.studentId,
        enrollmentId: enrollment.id,
        batchId,
        totalAmount: Math.max(total, 0),
        dueDate,
        status: args.status ?? FeeInvoiceStatus.PENDING,
        month,
        year,
        // schoolId is derived from the parent invoice's composite relation FK — omit it here.
        items: { create: items.map((i) => ({ type: i.type, feeHeadId: i.feeHeadId, description: i.description, amount: i.amount })) },
      },
      select: { id: true },
    });
  }

  /**
   * Fee heads already charged once on this enrolment (B3).
   *
   * ⚠️ **Scoped per ENROLMENT, not per year — and that distinction is the whole point.** A
   * per-year rule would re-charge the admission fee every time a child is promoted into the next
   * class, which is the single most obvious way to get this wrong. A student who leaves and later
   * re-enrols gets a NEW enrolment and is charged again, which matches what a school means by
   * "admission fee". **Assumed 2026-08-12; a school that treats it as once-per-child-for-life
   * needs the scope widened to the student, not a special case here.**
   *
   * ⚠️ Keyed on the fee HEAD, so a head priced both MONTHLY and ADMISSION would see the monthly
   * charge suppress the admission one. `inForceStructures` keys on `head:frequency`, so that
   * combination is expressible — it is just not something a school does, and the failure mode is
   * under-charging (a skipped admission fee, visible on the invoice) rather than double-charging.
   */
  private async chargedOnceHeadIds(enrollmentId: string): Promise<Set<string>> {
    const rows = await this.db.feeInvoiceItem.findMany({
      where: { invoice: { enrollmentId }, type: 'FEE', feeHeadId: { not: null } },
      select: { feeHeadId: true },
    });
    return new Set(rows.map((r) => r.feeHeadId).filter((id): id is string => id !== null));
  }

  /**
   * Where this child sits among their **currently enrolled** siblings, 1-based.
   *
   * Siblings are students sharing a **primary guardian** — `StudentGuardian` allows exactly one
   * `isPrimary` per student, and the CSV import deliberately links siblings to one parent account
   * by phone, so the relationship is already in the data rather than needing a new one.
   *
   * ⚠️ **Ordered by admission (`Student.createdAt`), tie-broken by GR number.** Two families in
   * identical situations must be charged identically, so the order cannot be incidental — an
   * unordered query would hand the discount to whichever row Postgres returned first.
   *
   * ⚠️ **"Currently enrolled" means the rank MOVES.** If the eldest leaves, the next child becomes
   * rank 1 and stops being discounted on FUTURE invoices; already-issued ones keep what they were
   * charged, because line items are frozen. The alternative — a rank remembered for ever — cannot
   * be explained from the data a year later. **Operator decision, assumed 2026-08-12; say so if a
   * school expects the discount to follow the child instead of the position.**
   */
  private async siblingRank(studentId: string, academicYearId: string): Promise<number> {
    const link = await this.db.studentGuardian.findFirst({
      where: { studentId, isPrimary: true },
      select: { parentId: true },
    });
    if (!link) return 1; // no primary guardian recorded ⇒ no family to rank within

    const family = await this.db.studentGuardian.findMany({
      where: {
        parentId: link.parentId,
        isPrimary: true,
        student: {
          deletedAt: null,
          enrollments: { some: { academicYearId, status: 'ACTIVE' } },
        },
      },
      select: { studentId: true, student: { select: { createdAt: true, grNumber: true } } },
    });
    if (family.length < 2) return 1;

    family.sort((a, b) => {
      const t = a.student.createdAt.getTime() - b.student.createdAt.getTime();
      return t !== 0 ? t : a.student.grNumber.localeCompare(b.student.grNumber);
    });
    return family.findIndex((f) => f.studentId === studentId) + 1;
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
    await this.mayReadFees();
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
      this.db.feeInvoice.findMany({
        where, skip, take, orderBy: { createdAt: 'desc' },
        // Carries the student's NAME. The Fees screen used to resolve it from a map built out of
        // `/students?pageSize=100`, so in any school past 100 students an invoice row showed a
        // truncated UUID where a child's name belongs — on the screen where money is collected.
        include: { student: { select: { fullName: true, grNumber: true } } },
      }),
      this.db.feeInvoice.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  async get(id: string) {
    await this.mayReadFees();
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
    await this.mayReadFees();
    const cutoff = new Date(Date.now() - (q.minDays ?? 0) * 86400000);
    const campusId = effectiveCampusFilter(this.ctx.user, q.campusId);
    const invoices = await this.db.feeInvoice.findMany({
      where: {
        status: { in: [FeeInvoiceStatus.PENDING, FeeInvoiceStatus.PARTIAL, FeeInvoiceStatus.OVERDUE] },
        dueDate: { lt: cutoff },
        // ⚠️ Forced for a campus-bound caller. This used the CLIENT's campusId as-is, so a campus-A accountant
        // who sent none — or sent campus B — received another campus's defaulters: names, GR numbers and
        // amounts owed. The reports copy of this query already forced it; this one did not.
        ...(campusId ? { enrollment: { campusId } } : {}),
      },
      include: {
        student: {
          select: {
            id: true, fullName: true, grNumber: true,
            // The primary guardian in the SAME query — a working list resolving one guardian per row would
            // be one query per defaulter.
            guardians: {
              where: { isPrimary: true },
              take: 1,
              select: { relation: true, parent: { select: { fullName: true, phone: true, phoneVerifiedAt: true, smsOptOut: true } } },
            },
          },
        },
      },
    });
    // One row per student, with everything the office needs to ACT on it — who to call, whether an SMS can
    // reach them, and how long it has been owed — rather than a list to look people up from elsewhere.
    const now = Date.now();
    const byStudent = new Map<string, DefaulterRow>();
    for (const inv of invoices) {
      const g = inv.student.guardians[0];
      const cur = byStudent.get(inv.studentId) ?? {
        student: { id: inv.student.id, fullName: inv.student.fullName, grNumber: inv.student.grNumber },
        outstanding: 0, invoices: 0, oldestDueDate: inv.dueDate, daysOverdue: 0,
        guardian: g ? {
          name: g.parent.fullName, relation: g.relation, phone: g.parent.phone,
          // Whether a reminder can actually arrive: SMS goes only to verified numbers that have not opted out.
          canText: g.parent.phoneVerifiedAt !== null && !g.parent.smsOptOut,
        } : null,
      };
      cur.outstanding = money(cur.outstanding + Number(inv.totalAmount) - Number(inv.paidAmount));
      cur.invoices += 1;
      if (inv.dueDate < cur.oldestDueDate) cur.oldestDueDate = inv.dueDate;
      cur.daysOverdue = Math.max(0, Math.floor((now - cur.oldestDueDate.getTime()) / 86_400_000));
      byStudent.set(inv.studentId, cur);
    }
    return [...byStudent.values()].sort((a, b) => b.outstanding - a.outstanding);
  }

  /**
   * Queue fee reminders for chosen defaulters (GAP-13).
   *
   * ⚠️ **The client sends ids, never amounts.** Each student's outstanding balance and oldest due date are
   * re-read here from the same defaulter query the list uses, so a reminder states what is owed NOW — not
   * what the screen showed an hour ago, and not a number anyone could edit in transit.
   *
   * ⚠️ **Campus scope comes from that query, not a separate check.** An id outside the caller's campus is
   * simply not a defaulter in their view, and is reported as skipped rather than texted.
   *
   * One reminder per student per day: the queue job id and the dispatcher's dedupe key both carry the date,
   * so sending the list twice in a morning costs the school nothing extra.
   */
  async remindDefaulters(studentIds: string[]): Promise<{ queued: number; skipped: { notDefaulting: number; cannotText: number } }> {
    const wanted = new Set(studentIds);
    const rows = (await this.defaulters({})).filter((r) => wanted.has(r.student.id));
    const day = new Date().toISOString().slice(0, 10);
    let queued = 0;
    let cannotText = 0;
    for (const r of rows) {
      if (!r.guardian?.canText) { cannotText += 1; continue; }
      await this.sms.enqueueFeeReminder({
        type: 'FEE_REMINDER', schoolId: this.sid, studentId: r.student.id,
        amount: r.outstanding, dueDate: r.oldestDueDate.toISOString().slice(0, 10), day,
      });
      queued += 1;
    }
    return { queued, skipped: { notDefaulting: wanted.size - rows.length, cannotText } };
  }

  private school() {
    return this.db.school.findFirst({ where: { id: this.sid } });
  }
}

/**
 * Collapse a price history to the one row in force per (fee head, frequency).
 *
 * Callers pass rows already filtered to `effectiveFrom <= the month being billed` and sorted
 * ascending, so the LAST row wins for each key. Keeping this a pure function means the
 * "which price applies?" rule is testable on its own and cannot drift between invoicing and
 * the fee-plan screen, which must agree about what a class currently costs.
 */
export function inForceStructures<T extends { feeHeadId: string; frequency: string; effectiveFrom: Date }>(
  rows: readonly T[],
): T[] {
  const latest = new Map<string, T>();
  for (const r of rows) latest.set(`${r.feeHeadId}:${r.frequency}`, r);
  return [...latest.values()];
}
