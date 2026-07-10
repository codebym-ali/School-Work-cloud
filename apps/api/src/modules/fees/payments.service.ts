import { createHash } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { FeeInvoiceStatus, PaymentMethod, Prisma } from '@prisma/client';
import {
  AppError,
  assertCampusAccess,
  AuditActions,
  ErrorCodes,
  paginate,
  restrictedCampusId,
  TenantContext,
  toSkipTake,
  type Paginated,
} from '@common';
import { AuditService, IdempotencyService, TenantPrismaService } from '@database';
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
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }
  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  async pay(invoiceId: string, dto: PayInvoiceDto, idempotencyKey: string) {
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

  /** Deposit into the guardian credit ledger (auto-application to invoices is a follow-up). */
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
    return paginate(rows, total, q);
  }

  // ── helpers ──────────────────────────────────────────────────────────────────
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
