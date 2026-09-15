import { HttpStatus, Injectable } from '@nestjs/common';
import { ClaimSource, ClaimStatus, PaymentMethod, Prisma } from '@prisma/client';
import {
  AppError,
  assertCampusAccess,
  AuditActions,
  ErrorCodes,
  paginate,
  parseSchoolSettings,
  restrictedCampusId,
  StorageService,
  TenantContext,
  toSkipTake,
  type Paginated,
} from '@common';
import { AuditService, TenantPrismaService } from '@database';
import { PaymentsService } from './payments.service';
import type { ClaimListQuery, RejectClaimDto, SubmitClaimDto } from './dto/fees.dto';

/**
 * Payment claims (§12) — "somebody says they have paid".
 *
 * **A claim is not a payment**, and keeping the two apart is the whole point of this service.
 * An unverified screenshot must never mint a receipt number, move `paidAmount`, appear in
 * collections or clear a defaulter before an exam: the office reconciles against the bank
 * statement, and a transfer is a claim until it does.
 *
 * Verifying one therefore does not write a payment itself — it calls the ordinary payment path,
 * so idempotency, the row lock, the gap-free receipt sequence, the fee-integrity check and the
 * receipt SMS all keep applying without a second implementation to drift from the first.
 */
@Injectable()
export class ClaimsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly audit: AuditService,
    private readonly payments: PaymentsService,
    private readonly storage: StorageService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }
  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  /**
   * Record that a payment is claimed. Does not touch the invoice.
   *
   * The office may verify in the same action (`autoVerify`) because the clerk who took the
   * money *is* the verifier — forcing a second review on them would be bureaucracy, not
   * control. Anything self-submitted always waits for a human.
   */
  async submit(dto: SubmitClaimDto, source: ClaimSource, autoVerify = false) {
    const invoice = await this.db.feeInvoice.findFirst({
      where: { id: dto.invoiceId },
      select: { id: true, studentId: true, totalAmount: true, paidAmount: true, status: true, enrollment: { select: { campusId: true } } },
    });
    if (!invoice) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Invoice not found');
    assertCampusAccess(this.ctx.user, invoice.enrollment.campusId);

    this.assertFileIsOurs(dto.proofFileKey);
    // Shared with the guardian-link path so the two cannot drift apart: the partial unique on
    // fee_payments is the backstop, this is the early, human-readable one.
    await this.assertRefUnused(dto.transactionRef, dto.method);

    const paidOn = new Date(dto.paidOn);
    const clearsOn = dto.method === PaymentMethod.CHEQUE ? await this.chequeClearsOn(paidOn) : null;

    const claim = await this.db.feePaymentClaim.create({
      data: {
        schoolId: this.sid,
        studentId: invoice.studentId,
        invoiceId: invoice.id,
        amount: dto.amount,
        method: dto.method,
        transactionRef: dto.transactionRef,
        paidOn,
        clearsOn,
        proofFileKey: dto.proofFileKey,
        note: dto.note,
        source,
        submittedById: this.ctx.user?.userId ?? null,
      },
    });
    await this.audit.record({
      action: AuditActions.FEE_CLAIM_SUBMITTED,
      entityType: 'FeePaymentClaim',
      entityId: claim.id,
      newValue: { invoiceId: invoice.id, amount: dto.amount, method: dto.method, source },
    });

    // ⚠️ A cheque can never verify itself, whatever the caller asked for. `autoVerify` exists for
    // the counter case — a clerk recording money already in the drawer — and a cheque is precisely
    // the case where the money is NOT in the drawer yet.
    return autoVerify && !clearsOn ? this.verify(claim.id) : claim;
  }

  /**
   * The guardian-link path (§5.2). Authorised by the signed token, not by a session.
   *
   * It cannot go through `submit()` because that calls `assertCampusAccess`, which fails closed
   * for a request with no principal — correctly so. The token is bound to one invoice, which is
   * a *narrower* authority than any campus grant, so the campus check has nothing to add here.
   *
   * Everything else is deliberately identical: same duplicate-reference rule, same file-ownership
   * rule, same audit action, same PENDING outcome. `autoVerify` is not a parameter — a guardian's
   * own screenshot verifying itself would defeat the entire claim/payment split.
   */
  async submitViaLink(invoiceId: string, dto: Omit<SubmitClaimDto, 'invoiceId' | 'autoVerify'>) {
    const invoice = await this.db.feeInvoice.findFirst({
      where: { id: invoiceId },
      select: { id: true, studentId: true },
    });
    if (!invoice) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Invoice not found');

    await this.assertRefUnused(dto.transactionRef, dto.method);
    this.assertFileIsOurs(dto.proofFileKey);

    const claim = await this.db.feePaymentClaim.create({
      data: {
        schoolId: this.sid,
        studentId: invoice.studentId,
        invoiceId: invoice.id,
        amount: dto.amount,
        method: dto.method,
        transactionRef: dto.transactionRef,
        paidOn: new Date(dto.paidOn),
        proofFileKey: dto.proofFileKey,
        note: dto.note,
        source: ClaimSource.GUARDIAN_LINK,
        // Nobody signed in — this is the case `submittedById` was made nullable for.
        submittedById: null,
      },
      select: { id: true, status: true, amount: true, createdAt: true },
    });
    // No AuditLog row, deliberately. `AuditLog.userId` is NOT NULL with an FK to `users`, because
    // the whole point of that table is attributing an action to a *person* — and here there is no
    // person, only whoever held the link. The alternatives were both worse than omission:
    // inventing an actor (the owner, say) would put a lie in the audit trail, and making the
    // column nullable would weaken it for every other action to accommodate this one.
    //
    // Nothing is actually lost: the claim row IS the record — it carries `source=GUARDIAN_LINK`,
    // a null `submittedById`, the timestamp, the amount, the reference and the proof file. And
    // the step that matters, verification, is audited against the real cashier who did it.
    return claim;
  }

  /** A file must live under this school's prefix — the only thing stopping a crafted key. */
  private assertFileIsOurs(proofFileKey: string | undefined | null): void {
    if (proofFileKey && !proofFileKey.startsWith(`uploads/${this.sid}/`)) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'That file does not belong to your school');
    }
  }

  /** The same reference twice is the commonest honest mistake — say so now, not at the counter. */
  private async assertRefUnused(transactionRef: string | undefined | null, method: PaymentMethod): Promise<void> {
    if (!transactionRef) return;
    const seen = await this.db.feePaymentClaim.findFirst({
      where: { transactionRef, method, status: { not: ClaimStatus.REJECTED } },
      select: { id: true, status: true },
    });
    if (seen) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        HttpStatus.CONFLICT,
        `Reference ${transactionRef} has already been submitted and is ${seen.status.toLowerCase()}.`,
      );
    }
  }

  /**
   * Confirm the money arrived, and only then create the payment.
   *
   * Idempotency-Key is derived from the claim id, so a double-click or a retried request
   * cannot produce two receipts for one claim.
   */
  async verify(claimId: string) {
    const claim = await this.claimOr404(claimId);
    if (claim.status !== ClaimStatus.PENDING) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        HttpStatus.CONFLICT,
        `This submission was already ${claim.status.toLowerCase()}${claim.paymentId ? ' — a receipt exists for it' : ''}.`,
      );
    }

    // ⚠️ D3 — a cheque is not money until it clears, so it cannot mint a receipt before then.
    // Verifying early is how a bounced cheque ends up with a receipt already issued, a family
    // holding proof of a payment the school never received, and a reversal to unwind it.
    if (claim.clearsOn && claim.clearsOn > startOfToday()) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        HttpStatus.CONFLICT,
        `This cheque clears on ${claim.clearsOn.toISOString().slice(0, 10)}. Verify it on or after that date — or reject it if it has bounced.`,
      );
    }

    const result = await this.payments.pay(
      claim.invoiceId,
      {
        amountPaid: Number(claim.amount),
        method: claim.method as PaymentMethod,
        transactionRef: claim.transactionRef ?? undefined,
        proofFileKey: claim.proofFileKey ?? undefined,
      },
      `claim:${claim.id}`,
      // The one door a cheque may come through: its clearing date has passed and a human verified it.
      { viaClaim: true },
    );

    const updated = await this.db.feePaymentClaim.update({
      where: { id: claimId },
      data: {
        status: ClaimStatus.VERIFIED,
        reviewedById: this.ctx.user!.userId,
        reviewedAt: new Date(),
        paymentId: result.paymentId,
      },
    });
    await this.audit.record({
      action: AuditActions.FEE_CLAIM_VERIFIED,
      entityType: 'FeePaymentClaim',
      entityId: claimId,
      newValue: { paymentId: result.paymentId, receiptNo: result.receiptNo, amount: Number(claim.amount) },
    });
    return { ...updated, receiptNo: result.receiptNo };
  }

  /** Turn it down, with a reason the submitter can act on. Nothing financial changes. */
  async reject(claimId: string, dto: RejectClaimDto) {
    const claim = await this.claimOr404(claimId);
    if (claim.status !== ClaimStatus.PENDING) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, `This submission was already ${claim.status.toLowerCase()}.`);
    }
    const updated = await this.db.feePaymentClaim.update({
      where: { id: claimId },
      data: {
        status: ClaimStatus.REJECTED,
        reviewedById: this.ctx.user!.userId,
        reviewedAt: new Date(),
        rejectionReason: dto.reason,
      },
    });
    await this.audit.record({
      action: AuditActions.FEE_CLAIM_REJECTED,
      entityType: 'FeePaymentClaim',
      entityId: claimId,
      reason: dto.reason,
      oldValue: { amount: Number(claim.amount), method: claim.method, transactionRef: claim.transactionRef },
    });
    return updated;
  }

  async list(q: ClaimListQuery): Promise<Paginated<unknown>> {
    const where: Prisma.FeePaymentClaimWhereInput = {};
    if (q.status) where.status = q.status as ClaimStatus;
    if (q.studentId) where.studentId = q.studentId;
    const restricted = restrictedCampusId(this.ctx.user);
    if (restricted !== null) where.invoice = { enrollment: { campusId: restricted } };

    const { skip, take } = toSkipTake(q);
    const [rows, total] = await Promise.all([
      this.db.feePaymentClaim.findMany({
        where, skip, take,
        // Oldest first: a queue is worked through, and the family waiting longest goes first.
        orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
        include: {
          student: { select: { fullName: true, grNumber: true } },
          invoice: { select: { month: true, year: true, totalAmount: true, paidAmount: true } },
        },
      }),
      this.db.feePaymentClaim.count({ where }),
    ]);
    // The storage key never leaves the server — presence only, same rule as the payments list.
    const safe = rows.map(({ proofFileKey, ...c }) => ({ ...c, hasProof: proofFileKey !== null }));
    return paginate(safe, total, q);
  }

  /** How many are waiting on a human — powers the dashboard chip. */
  async pendingCount(): Promise<number> {
    const restricted = restrictedCampusId(this.ctx.user);
    return this.db.feePaymentClaim.count({
      where: { status: ClaimStatus.PENDING, ...(restricted !== null ? { invoice: { enrollment: { campusId: restricted } } } : {}) },
    });
  }

  /**
   * The date this cheque becomes money: the day it was taken plus the school's own holding period.
   *
   * Read from settings ONCE, at submission, and then stored on the claim — see the column comment.
   */
  private async chequeClearsOn(paidOn: Date): Promise<Date> {
    const school = await this.db.school.findFirst({ where: { id: this.sid }, select: { settings: true } });
    const { chequeClearingDays } = parseSchoolSettings(school?.settings ?? {}).feeSubmission;
    const d = new Date(paidOn);
    d.setUTCDate(d.getUTCDate() + chequeClearingDays);
    return d;
  }

  /** Short-lived link to the submitted evidence — keyed on the claim, never on the file key. */
  async proofUrl(claimId: string) {
    const claim = await this.claimOr404(claimId);
    if (!claim.proofFileKey) {
      throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'No proof was attached to this submission');
    }
    const expiresInSeconds = 600;
    const url = await this.storage.presignGet(claim.proofFileKey, expiresInSeconds, 'payment-proof');
    return { url, expiresInSeconds };
  }

  private async claimOr404(id: string) {
    const claim = await this.db.feePaymentClaim.findFirst({
      where: { id },
      include: { invoice: { select: { enrollment: { select: { campusId: true } } } } },
    });
    if (!claim) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Payment submission not found');
    assertCampusAccess(this.ctx.user, claim.invoice.enrollment.campusId);
    return claim;
  }
}

/** Midnight today, UTC — the boundary a `@db.Date` column is compared against. */
function startOfToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
