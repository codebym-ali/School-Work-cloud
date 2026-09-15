import { createHash } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { FeeInvoiceStatus, PaymentMethod, Prisma } from '@prisma/client';
import {
  AppError,
  assertCampusAccess,
  AuditActions,
  ErrorCodes,
  paginate,
  parseSchoolSettings,
  PdfService,
  StorageService,
  restrictedCampusId,
  TenantContext,
  toSkipTake,
  type Paginated,
} from '@common';
import { AuditService, IdempotencyService, TenantPrismaService } from '@database';
import { AccessService } from '../access/access.service';
import { SmsProducer } from '../comms/sms/sms-producer.service';
import type { CreateAdvanceDto, PayInvoiceDto, PaymentListQuery, ReasonDto } from './dto/fees.dto';

const money = (n: number): number => Math.round(n * 100) / 100;
const hashOf = (parts: unknown): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/**
 * Payments (blueprint §12, §25.4/§25.5). Every payment runs under an Idempotency-Key
 * and a row lock (`SELECT … FOR UPDATE`) inside the request transaction, with a
 * gap-free per-school receipt number. Payments are immutable — corrections are
 * PaymentReversals (OWNER_ADMIN only).
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly sms: SmsProducer,
    private readonly access: AccessService,
    private readonly storage: StorageService,
    private readonly pdf: PdfService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }
  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  async pay(invoiceId: string, dto: PayInvoiceDto, idempotencyKey: string, opts: { viaClaim?: boolean } = {}) {
    await this.access.assert('fees.payments');
    /**
     * ⚠️ D3 — a cheque cannot be collected straight into a receipt.
     *
     * It is recorded as a submission and clears on the school's own holding period; verifying that
     * submission is what mints the receipt, and it arrives back here with `viaClaim`. Without this
     * guard the rule would live only in the UI, and "a display gate over an open endpoint is not a
     * rule" — the same reasoning as `assertMethodAccepted` below.
     */
    if (dto.method === PaymentMethod.CHEQUE && !opts.viaClaim) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'A cheque is recorded as a submission and clears before it becomes a receipt. Record it under Payment submissions.',
      );
    }
    if (!idempotencyKey) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.BAD_REQUEST, 'Idempotency-Key header is required');
    }
    const result = await this.idempotency.run(idempotencyKey, hashOf({ invoiceId, ...dto }), async () => {
      // Lock the invoice row for the life of the transaction (§25.5).
      await this.db.$queryRaw(Prisma.sql`SELECT id FROM fee_invoices WHERE id = ${invoiceId}::uuid FOR UPDATE`);

      const invoice = await this.db.feeInvoice.findFirst({
        where: { id: invoiceId },
        include: { enrollment: { select: { campusId: true } } },
      });
      if (!invoice) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Invoice not found');
      // Campus scoping (§22.8, P1.7): a campus-bound cashier may only collect for their campus.
      assertCampusAccess(this.ctx.user, invoice.enrollment.campusId);
      if (invoice.status === FeeInvoiceStatus.WAIVED || invoice.status === FeeInvoiceStatus.PAID) {
        throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, `Invoice is ${invoice.status}`);
      }
      if (dto.method !== PaymentMethod.CASH && !dto.transactionRef) {
        throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'transactionRef required for non-cash payments');
      }
      // The school's own list of what it accepts, enforced HERE and not merely hidden from the
      // dropdown — a display gate over an open endpoint is not a rule (see F8 in the fees
      // register). ADVANCE is exempt: it is not a way of paying, it is the school applying a
      // credit the guardian already deposited.
      await this.assertMethodAccepted(dto.method);
      await this.assertProofAcceptable(dto.method, dto.proofFileKey);
      const remaining = money(Number(invoice.totalAmount) - Number(invoice.paidAmount));
      if (dto.amountPaid > remaining) {
        throw new AppError(ErrorCodes.OVERPAYMENT_USE_ADVANCE, HttpStatus.UNPROCESSABLE_ENTITY, `Amount exceeds remaining ${remaining}; use the advance endpoint`);
      }

      const receiptNo = await this.nextReceiptNo();
      const payment = await this.db.feePayment.create({
        data: {
          schoolId: this.sid,
          invoiceId,
          receiptNo,
          amountPaid: dto.amountPaid,
          method: dto.method,
          transactionRef: dto.transactionRef,
          proofFileKey: dto.proofFileKey,
          collectedById: this.ctx.user!.userId,
        },
      });

      const paidAmount = money(Number(invoice.paidAmount) + dto.amountPaid);
      const status = paidAmount >= Number(invoice.totalAmount) ? FeeInvoiceStatus.PAID : FeeInvoiceStatus.PARTIAL;
      await this.db.feeInvoice.update({ where: { id: invoiceId }, data: { paidAmount, status } });

      await this.sms.enqueueReceipt({
        type: 'FEE_RECEIPT',
        schoolId: this.sid,
        studentId: invoice.studentId,
        invoiceId,
        amount: dto.amountPaid,
        receiptNo,
      });

      return {
        status: 201,
        body: { paymentId: payment.id, receiptNo, amountPaid: dto.amountPaid, invoiceStatus: status, paidAmount },
      };
    });
    return result.body;
  }

  /** Reversal (OWNER_ADMIN) — payments are immutable; this is the only correction. */
  async reverse(paymentId: string, dto: ReasonDto) {
    const payment = await this.db.feePayment.findFirst({ where: { id: paymentId } });
    if (!payment) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Payment not found');
    const dupe = await this.db.paymentReversal.findFirst({ where: { paymentId } });
    if (dupe) throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Payment already reversed');

    const receiptNo = await this.nextReceiptNo();
    const reversal = await this.db.paymentReversal.create({
      data: { schoolId: this.sid, paymentId, receiptNo, reason: dto.reason, approvedById: this.ctx.user!.userId },
    });
    await this.recomputeInvoice(payment.invoiceId);
    await this.audit.record({
      action: AuditActions.PAYMENT_REVERSED,
      entityType: 'FeePayment',
      entityId: paymentId,
      reason: dto.reason,
      newValue: { reversalReceiptNo: `RV-${receiptNo}` },
    });
    return { reversalId: reversal.id, receiptNo: `RV-${receiptNo}` };
  }

  /** Deposit into the guardian credit ledger. The balance is consumed automatically as the
   *  guardian's invoices are generated (see `applyAdvanceToInvoice`), not retroactively. */
  async deposit(dto: CreateAdvanceDto, idempotencyKey: string) {
    if (!idempotencyKey) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.BAD_REQUEST, 'Idempotency-Key header is required');
    }
    const result = await this.idempotency.run(idempotencyKey, hashOf(dto), async () => {
      await this.db.guardianCredit.create({
        data: { schoolId: this.sid, parentId: dto.parentId, amount: dto.amount, refType: 'DEPOSIT', createdById: this.ctx.user!.userId },
      });
      const balance = await this.creditBalance(dto.parentId);
      return { status: 201, body: { parentId: dto.parentId, balance } };
    });
    return result.body;
  }

  async creditBalance(parentId: string): Promise<number> {
    const agg = await this.db.guardianCredit.aggregate({ _sum: { amount: true }, where: { parentId } });
    return money(Number(agg._sum.amount ?? 0));
  }

  /**
   * Auto-apply the primary guardian's available advance to ONE freshly-generated invoice
   * (§12). Called from batch generation so a new invoice consumes standing credit. Records
   * a FeePayment (method ADVANCE, real receipt number) + a negative GuardianCredit entry so
   * recompute, receipts and the fee-integrity check stay consistent. Returns the amount
   * applied. Runs inside the caller's request transaction.
   */
  async applyAdvanceToInvoice(invoiceId: string): Promise<number> {
    const invoice = await this.db.feeInvoice.findFirst({
      where: { id: invoiceId },
      include: { student: { select: { guardians: { where: { isPrimary: true }, select: { parentId: true } } } } },
    });
    if (!invoice) return 0;
    const parentId = invoice.student.guardians[0]?.parentId;
    if (!parentId) return 0;

    const remaining = money(Number(invoice.totalAmount) - Number(invoice.paidAmount));
    if (remaining <= 0) return 0;
    const balance = await this.creditBalance(parentId);
    if (balance <= 0) return 0;
    const apply = money(Math.min(balance, remaining));

    const receiptNo = await this.nextReceiptNo();
    await this.db.feePayment.create({
      data: { schoolId: this.sid, invoiceId, receiptNo, amountPaid: apply, method: 'ADVANCE', collectedById: this.ctx.user!.userId },
    });
    await this.db.guardianCredit.create({
      data: { schoolId: this.sid, parentId, amount: -apply, refType: 'APPLIED_TO_INVOICE', refId: invoiceId, createdById: this.ctx.user!.userId },
    });
    const paidAmount = money(Number(invoice.paidAmount) + apply);
    const status = paidAmount >= Number(invoice.totalAmount) ? FeeInvoiceStatus.PAID : FeeInvoiceStatus.PARTIAL;
    await this.db.feeInvoice.update({ where: { id: invoiceId }, data: { paidAmount, status } });
    return apply;
  }

  async listPayments(q: PaymentListQuery): Promise<Paginated<unknown>> {
    const where: Prisma.FeePaymentWhereInput = {};
    if (q.method) where.method = q.method;
    if (q.collectedById) where.collectedById = q.collectedById;
    if (q.from || q.to) where.paidAt = { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) };
    // Campus scoping (§22.8, P1.7): confine a campus-bound cashier to their campus's payments.
    const restricted = restrictedCampusId(this.ctx.user);
    if (restricted !== null) where.invoice = { enrollment: { campusId: restricted } };
    const { skip, take } = toSkipTake(q);
    const [rows, total] = await Promise.all([
      this.db.feePayment.findMany({ where, skip, take, orderBy: { paidAt: 'desc' } }),
      this.db.feePayment.count({ where }),
    ]);
    // Report only that proof EXISTS, never the storage key. The key is how a file is addressed;
    // broadcasting it in a list invites someone to try it somewhere the ownership check is
    // weaker. Reading the file goes through `proofUrl`, which authorises the payment first.
    const safe = rows.map(({ proofFileKey, ...p }) => ({ ...p, hasProof: proofFileKey !== null }));
    return paginate(safe, total, q);
  }

  // ── helpers ──────────────────────────────────────────────────────────────────
  /**
   * Refuse a payment method this school does not accept.
   *
   * `ADVANCE` is exempt by design: it is not a way of paying, it is the school applying a credit
   * the guardian already deposited, so a school that accepts only cash must still be able to
   * draw down an advance.
   *
   * Refusing here rather than only omitting the option from the dropdown is the whole point —
   * an unenforced setting is decoration, and the same mistake is already logged as F8 (fee
   * prices hidden in the UI but readable by anyone signed in).
   */
  private async assertMethodAccepted(method: PaymentMethod): Promise<void> {
    if (method === PaymentMethod.ADVANCE) return;
    const school = await this.db.school.findFirst({ where: { id: this.sid }, select: { settings: true } });
    const { methods } = parseSchoolSettings(school?.settings ?? {}).feeSubmission;
    if (!methods.includes(method as (typeof methods)[number])) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        HttpStatus.UNPROCESSABLE_ENTITY,
        `This school does not accept ${method.replace('_', ' ').toLowerCase()} payments. `
        + `Accepted: ${methods.join(', ')}. An owner can change this in School settings.`,
      );
    }
  }

  /**
   * Enforce the school's proof policy, and refuse a key that is not this school's.
   *
   * `REQUIRED` applies only to non-cash: cash over the counter has no screenshot and demanding
   * one would make the commonest payment in a Pakistani school impossible to record. `ADVANCE`
   * is exempt for the same reason it is exempt from the method list — nobody hands over money,
   * the school is drawing down a credit it already holds.
   *
   * The key check is the security half. `confirmUpload` writes objects under
   * `uploads/{schoolId}/`, so a key from another tenant is refused here rather than being
   * stored and later presigned — a stored key is a capability, and it must be validated at the
   * moment it is accepted, not at the moment it is used.
   */
  private async assertProofAcceptable(method: PaymentMethod, proofFileKey?: string): Promise<void> {
    if (proofFileKey && !proofFileKey.startsWith(`uploads/${this.sid}/`)) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'That file does not belong to your school');
    }
    if (method === PaymentMethod.CASH || method === PaymentMethod.ADVANCE) return;

    const school = await this.db.school.findFirst({ where: { id: this.sid }, select: { settings: true } });
    const { proofPolicy } = parseSchoolSettings(school?.settings ?? {}).feeSubmission;
    if (proofPolicy === 'REQUIRED' && !proofFileKey) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'This school requires proof of payment for non-cash payments — attach the transfer screenshot or stamped challan.',
      );
    }
  }

  /**
   * A short-lived link to the proof attached to one payment.
   *
   * Deliberately keyed on the PAYMENT, not on the file key. A generic "give me a URL for this
   * key" endpoint would hand a signed link to anyone who could guess or replay an opaque
   * string; resolving the key only AFTER authorising the payment means the ownership check
   * cannot be bypassed. Same shape as the documents and payslip readers.
   */
  async proofUrl(paymentId: string): Promise<{ url: string; expiresInSeconds: number }> {
    const payment = await this.db.feePayment.findFirst({
      where: { id: paymentId },
      select: { proofFileKey: true, receiptNo: true, invoice: { select: { enrollment: { select: { campusId: true } } } } },
    });
    if (!payment) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Payment not found');
    // A campus-bound cashier sees their own campus's payments only (§22.8, P1.7).
    assertCampusAccess(this.ctx.user, payment.invoice.enrollment.campusId);
    if (!payment.proofFileKey) {
      throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'No proof was attached to this payment');
    }
    const expiresInSeconds = 600;
    const url = await this.storage.presignGet(payment.proofFileKey, expiresInSeconds, `receipt-${payment.receiptNo}-proof`);
    return { url, expiresInSeconds };
  }

  /**
   * The receipt as a PDF — the thing the family actually asks for.
   *
   * Rendered on demand rather than stored at payment time: a receipt is a *view* of the payment
   * and the invoice around it, and both can legitimately move afterwards (a later instalment
   * changes "still outstanding", a reversal voids the whole thing). A file frozen at 16:04 on the
   * day of payment would quietly start disagreeing with the ledger it came from.
   *
   * Reversed payments are refused outright. Handing someone a clean-looking receipt for money
   * that has been reversed is how a receipt stops meaning anything.
   *
   * Access mirrors `proofUrl`: campus-scoped for staff, and a STUDENT may fetch their own — the
   * check is in the service because it reads tenant rows (§22.8).
   */
  async receiptPdf(paymentId: string): Promise<{ url: string; expiresInSeconds: number }> {
    const payment = await this.db.feePayment.findFirst({
      where: { id: paymentId },
      select: {
        id: true, receiptNo: true, amountPaid: true, method: true, transactionRef: true, paidAt: true,
        reversal: { select: { id: true } },
        collectedBy: { select: { email: true } },
        invoice: {
          select: {
            month: true, year: true, totalAmount: true, paidAmount: true,
            enrollment: { select: { campusId: true, class: { select: { name: true } } } },
            student: { select: { fullName: true, grNumber: true, userId: true } },
          },
        },
      },
    });
    if (!payment) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Payment not found');

    const caller = this.ctx.user!;
    const isStudent = caller.roles.includes('STUDENT');
    if (isStudent) {
      // Self-scoped by the record, never by an id from the client.
      if (payment.invoice.student.userId !== caller.userId) {
        throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Payment not found');
      }
    } else {
      assertCampusAccess(this.ctx.user, payment.invoice.enrollment.campusId);
    }

    if (payment.reversal) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        HttpStatus.CONFLICT,
        `Receipt #${payment.receiptNo} was reversed — there is no valid receipt for it.`,
      );
    }

    const school = await this.db.school.findFirst({ where: { id: this.sid }, select: { name: true } });
    const buffer = await this.pdf.feeReceipt({
      schoolName: school?.name ?? 'School',
      receiptNo: payment.receiptNo,
      studentName: payment.invoice.student.fullName,
      grNumber: payment.invoice.student.grNumber,
      className: payment.invoice.enrollment.class.name,
      period: payment.invoice.month ? `${payment.invoice.month}/${payment.invoice.year}` : String(payment.invoice.year),
      paidOn: payment.paidAt.toISOString().slice(0, 10),
      method: payment.method,
      amountPaid: Number(payment.amountPaid),
      invoiceTotal: Number(payment.invoice.totalAmount),
      paidToDate: Number(payment.invoice.paidAmount),
      receivedBy: payment.collectedBy.email,
      transactionRef: payment.transactionRef,
    });

    const fileKey = `receipts/${this.sid}/${payment.id}.pdf`;
    await this.storage.putObject(fileKey, buffer, 'application/pdf');
    const expiresInSeconds = 600;
    const url = await this.storage.presignGet(fileKey, expiresInSeconds, `receipt-${payment.receiptNo}.pdf`);
    return { url, expiresInSeconds };
  }

  /** Gap-free per-school receipt number (shared by payments and reversals). */
  private async nextReceiptNo(): Promise<number> {
    const school = await this.db.school.update({ where: { id: this.sid }, data: { nextReceiptNo: { increment: 1 } } });
    return school.nextReceiptNo - 1;
  }

  private async recomputeInvoice(invoiceId: string): Promise<void> {
    const invoice = await this.db.feeInvoice.findFirst({ where: { id: invoiceId }, include: { payments: true } });
    if (!invoice) return;
    const reversals = await this.db.paymentReversal.findMany({ where: { payment: { invoiceId } } });
    const reversedIds = new Set(reversals.map((r) => r.paymentId));
    const paidAmount = money(
      invoice.payments.filter((p) => !reversedIds.has(p.id)).reduce((s, p) => s + Number(p.amountPaid), 0),
    );
    const total = Number(invoice.totalAmount);
    const status = paidAmount >= total ? FeeInvoiceStatus.PAID : paidAmount > 0 ? FeeInvoiceStatus.PARTIAL : FeeInvoiceStatus.PENDING;
    await this.db.feeInvoice.update({ where: { id: invoiceId }, data: { paidAmount, status } });
  }
}
