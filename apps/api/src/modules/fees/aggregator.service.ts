import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PaymentMethod } from '@prisma/client';
import { AppError, CLS_KEYS, ENV, ErrorCodes, type Env } from '@common';
import { ClsService } from 'nestjs-cls';
import { PlatformPrismaService, TenantPrismaService } from '@database';
import type { AggregatorSettlementDto } from './dto/fees.dto';

/**
 * The payment-aggregator seam (Fee Submission Plan §5.3) — **the seam only**.
 *
 * The right integration for Pakistan is an aggregator (Kuickpay / 1Bill / 1LINK), not a card
 * gateway: the parent pays inside their own bank app, which is what they already trust. The
 * invoice carries a **PSID** (consumer number) printed on the challan; the parent quotes it; the
 * aggregator posts settlement back here.
 *
 * **Not integrated, deliberately.** There is no merchant agreement, no company code and no
 * sandbox, so nothing issues a PSID yet and the webhook is unreachable in practice (no secret
 * configured ⇒ every call is refused). What exists is the shape, so the day a contract is signed
 * is a wiring job rather than a redesign — and so the decisions below are made now, while they
 * are cheap, rather than under deadline.
 *
 * The one thing that genuinely differs from every other payment route: **settlement is not a
 * claim.** A guardian's screenshot is somebody's word and waits for a human; an aggregator
 * callback is the bank saying the money moved, so it is destined to write a `FeePayment`
 * directly with `method = ONLINE` rather than something a clerk verifies. That is also why the
 * HMAC matters so much here — the signature is the only thing standing between a forged POST and
 * a free receipt.
 *
 * What is real today: the signature check, the fail-closed behaviour when no secret is set, the
 * cross-tenant PSID lookup and the replay guard. What is deliberately **not** written is the
 * payment itself — see the note at the end of `settle()` for the one decision that blocks it.
 */
@Injectable()
export class AggregatorService {
  private readonly logger = new Logger(AggregatorService.name);

  constructor(
    private readonly platform: PlatformPrismaService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly cls: ClsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * A deterministic consumer number for an invoice.
   *
   * Deterministic on purpose: it is printed on a challan that may be reprinted, quoted over the
   * phone and typed into a bank app weeks later, so it must be reproducible and must never be
   * reassigned. Derived from the school's numeric prefix plus the invoice's own receipt-style
   * sequence rather than from a UUID, because a parent has to be able to read it aloud.
   *
   * Not called by anything yet — no school has an aggregator. It is here so the format is fixed
   * before anyone's challans are printed with it.
   */
  psidFor(schoolPrefix: string, invoiceSeq: number): string {
    return `${schoolPrefix}${String(invoiceSeq).padStart(10, '0')}`;
  }

  /**
   * Verify an aggregator callback and record the payment.
   *
   * Public and unauthenticated like the SMS delivery webhook, so the signature IS the auth. The
   * signed payload deliberately covers the amount as well as the identifiers: signing only the
   * PSID would let anyone who saw one legitimate callback replay it for a different figure.
   */
  async settle(signature: string | undefined, dto: AggregatorSettlementDto): Promise<void> {
    const secret = this.env.AGGREGATOR_WEBHOOK_HMAC_SECRET;
    if (!secret) {
      // No secret configured ⇒ no school is integrated ⇒ there is nothing legitimate to accept.
      // Fail closed rather than fall back to "unsigned is fine", which is how a stub becomes a
      // hole the day it ships to production half-configured.
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Aggregator settlement is not enabled');
    }
    const expected = createHmac('sha256', secret)
      .update(`${dto.psid}.${dto.amount}.${dto.aggregatorRef}`)
      .digest('hex');
    if (!signature || !safeEqualHex(signature, expected)) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Invalid webhook signature');
    }

    // Cross-tenant lookup: the caller is a bank, not a school, so there is no Host to resolve the
    // tenant from. The PSID itself carries the tenancy — hence the unique index on (school, psid).
    const invoice = await this.platform.feeInvoice.findFirst({
      where: { psid: dto.psid },
      select: { id: true, schoolId: true, totalAmount: true, paidAmount: true },
    });
    if (!invoice) {
      // Ack silently, like the SMS webhook: an unknown id is not something the bank can fix by
      // retrying, and a 404 would tell an unauthenticated caller which PSIDs exist.
      this.logger.warn(`Aggregator settlement for unknown PSID ${dto.psid} — ignored`);
      return;
    }

    // Idempotency check runs even now, because it is the part most likely to be got wrong later
    // and it costs nothing to have working from the start: banks retry, and a retried callback
    // must never mint a second receipt for one payment.
    const already = await this.cls.run(async () => {
      this.cls.set(CLS_KEYS.schoolId, invoice.schoolId);
      return this.tenantPrisma.withTenant(() =>
        this.tenantPrisma.client.feePayment.findFirst({
          where: { method: PaymentMethod.ONLINE, transactionRef: dto.aggregatorRef },
          select: { id: true },
        }),
      );
    });
    if (already) return; // already settled — ack and do nothing

    /**
     * ⚠️ **The seam stops here, on purpose.**
     *
     * Writing the `FeePayment` needs an answer to "who collected this?", and `collectedById` is
     * NOT NULL with an FK to `users` because that column exists to name the clerk who took the
     * money. A bank settled this; there is no clerk. The three ways to paper over that are all
     * worse than stopping:
     *   - take an id from the callback body — an **unauthenticated caller choosing the actor**;
     *   - attribute it to the school's owner — a lie in the ledger, and the same mistake the
     *     guardian link deliberately avoided by writing no audit row at all;
     *   - make the column nullable — weakens it for every real payment to serve one that does
     *     not exist yet.
     *
     * The right answer is a per-school **service account** for machine-made payments, which is a
     * product decision with an owner, not something to invent inside a stub. Until then this
     * refuses loudly rather than half-working: a bank gets a clear 501, nobody can mistake the
     * endpoint for live, and the signature/idempotency/tenancy logic above is real and tested.
     */
    this.logger.warn(
      `Aggregator settlement verified for PSID ${dto.psid} (${dto.aggregatorRef}) but not recorded — ` +
        'no service account exists to attribute a machine-made payment to (Fee Submission Plan §5.3).',
    );
    throw new AppError(
      ErrorCodes.NOT_IMPLEMENTED,
      HttpStatus.NOT_IMPLEMENTED,
      'Online settlement is not enabled for this school yet.',
    );
  }
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
