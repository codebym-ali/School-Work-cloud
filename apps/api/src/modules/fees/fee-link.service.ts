import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ClaimSource, ClaimStatus } from '@prisma/client';
import {
  AppError,
  assertCampusAccess,
  ENV,
  ErrorCodes,
  parseSchoolSettings,
  TenantContext,
  type Env,
} from '@common';
import { TenantPrismaService } from '@database';
import { ClaimsService } from './claims.service';
import { UploadsService } from '../uploads/uploads.service';
import type { SubmitLinkClaimDto } from './dto/fees.dto';

/** How long a link stays usable. Long enough to cover a fee cycle, short enough to expire. */
const TOKEN_TTL_DAYS = 30;
/** Domain separator — this key signs other things (CNIC hashes, OTPs) and must not be reused raw. */
const HMAC_CONTEXT = 'fee-link-v1';

/**
 * The guardian upload link (§12, Fee Submission Plan §5.2) — a public, no-login surface.
 *
 * Guardians are contact records, not accounts: the parent portal was removed deliberately and
 * this must not resurrect it. But guardians already receive fee SMS, so the SMS can carry a
 * signed, expiring link to ONE invoice. The page shows the child's first name and the amount,
 * takes a screenshot and a reference, and creates a PENDING claim. Nothing here moves money.
 *
 * **The token is the authorisation.** There is no session, so every other check has to be
 * carried by the token itself:
 *  - it is bound to a single `invoiceId` and signed with HMAC-SHA256, so it cannot be edited
 *    into a different invoice — changing one byte invalidates the signature;
 *  - it expires;
 *  - the school is resolved from the HOST, not from the token, and the invoice is then read
 *    inside the tenant transaction — so a token from one school cannot address another's
 *    invoice even if the id were guessed. RLS is the backstop, not the only check;
 *  - the response reveals only the child's FIRST name, the amount and the due date. A guardian
 *    link is a bearer credential that travels by SMS and gets forwarded; it must not be a
 *    window into the student record.
 *
 * Deliberately **stateless** — no token table. There is nothing to leak, nothing to clean up,
 * and no migration. Revocation is by expiry and by the one-pending-claim rule below; a school
 * that needs a hard kill switch turns `feeSubmission.guardianUploadLink` off.
 */
@Injectable()
export class FeeLinkService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly claims: ClaimsService,
    private readonly uploads: UploadsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }
  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.env.ENCRYPTION_MASTER_KEY)
      .update(`${HMAC_CONTEXT}:${payload}`)
      .digest('base64url');
  }

  /** Mint a link token for one invoice. The office calls this; the guardian only ever sees it. */
  issue(invoiceId: string, ttlDays = TOKEN_TTL_DAYS): string {
    const exp = Math.floor(Date.now() / 1000) + ttlDays * 86400;
    const payload = `${invoiceId}.${exp}`;
    return `${Buffer.from(payload).toString('base64url')}.${this.sign(payload)}`;
  }

  /**
   * The office asks for a link to send a family. Campus-scoped like every other invoice read —
   * a campus admin must not be able to mint a credential for another campus's bill.
   *
   * Returns the whole URL, not just the token: the school pastes this into WhatsApp, and a bare
   * token would have to be assembled by hand at every call site (SMS, the screen, a future
   * reminder job) with a different chance of getting the host wrong each time.
   */
  async issueFor(invoiceId: string, requestHost?: string) {
    const settings = await this.assertEnabled();
    const invoice = await this.db.feeInvoice.findFirst({
      where: { id: invoiceId },
      select: { id: true, status: true, enrollment: { select: { campusId: true } } },
    });
    if (!invoice) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Invoice not found');
    assertCampusAccess(this.ctx.user, invoice.enrollment.campusId);
    if (invoice.status === 'PENDING_APPROVAL') {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'This voucher is awaiting the owner\'s approval — no payment link yet');
    }

    const token = this.issue(invoice.id);
    return {
      token,
      url: `${this.originFor(requestHost)}/p/${token}`,
      expiresInDays: TOKEN_TTL_DAYS,
      proofPolicy: settings.feeSubmission.proofPolicy,
    };
  }

  /**
   * The origin to put in the link — which is **not** the origin this request arrived on.
   *
   * Two wrong answers were tried first, and both produced a URL the clerk copies and the parent
   * cannot open:
   *  - all of `APP_APEX_DOMAIN`: gives the apex, losing the school's subdomain entirely;
   *  - all of the request Host: in dev the Next proxy forwards `demo.localhost` but rewrites the
   *    port to the API's, so the link came out as `demo.localhost:4000` — the API, not the app.
   *
   * So take the part each source is actually authoritative for: the **tenant host** from the
   * request (it is the school the office is signed into) and the **browser-facing port** from
   * config (only the deployment knows where the web app is served). In production the apex
   * carries no port and this reduces to `https://<subdomain>.<apex>/p/…`.
   */
  private originFor(requestHost?: string): string {
    const bare = (requestHost?.trim() || this.env.APP_APEX_DOMAIN).split(':')[0].toLowerCase();
    const apexPort = this.env.APP_APEX_DOMAIN.split(':')[1];
    const local = bare === 'localhost' || bare.endsWith('.localhost') || bare === '127.0.0.1';
    return `${local ? 'http' : 'https'}://${bare}${apexPort ? `:${apexPort}` : ''}`;
  }

  /**
   * Verify a token and return the invoice id it is bound to.
   *
   * Every failure — bad shape, bad signature, expired — is the SAME error. A public endpoint
   * that distinguishes "no such token" from "expired token" from "wrong signature" is an oracle,
   * and there is nothing useful a legitimate guardian does with the difference.
   */
  private invoiceIdFrom(token: string): string {
    const invalid = () =>
      new AppError(
        ErrorCodes.NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'This link is not valid any more. Ask the school office for a new one.',
      );

    const [body, sig] = token.split('.');
    if (!body || !sig) throw invalid();

    let payload: string;
    try {
      payload = Buffer.from(body, 'base64url').toString('utf8');
    } catch {
      throw invalid();
    }

    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(sig);
    // Length-check first: timingSafeEqual throws on a length mismatch rather than returning false.
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw invalid();

    const [invoiceId, exp] = payload.split('.');
    if (!invoiceId || !exp) throw invalid();
    if (Number(exp) * 1000 < Date.now()) throw invalid();
    return invoiceId;
  }

  /**
   * The school must have switched this on. Off → 404, not 403: an unconfigured school should
   * not confirm that the surface exists at all.
   */
  private async assertEnabled() {
    const school = await this.db.school.findFirst({ where: { id: this.sid }, select: { settings: true } });
    const settings = parseSchoolSettings(school?.settings ?? {});
    if (!settings.feeSubmission.guardianUploadLink) {
      throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Not found');
    }
    return settings;
  }

  private async loadInvoice(token: string) {
    const settings = await this.assertEnabled();
    const invoiceId = this.invoiceIdFrom(token);
    const invoice = await this.db.feeInvoice.findFirst({
      where: { id: invoiceId },
      select: {
        id: true, month: true, year: true, dueDate: true, status: true,
        totalAmount: true, paidAmount: true,
        student: { select: { fullName: true } },
      },
    });
    // The token verified but the invoice is gone (or belongs to another tenant, which RLS makes
    // indistinguishable from gone). Same message as an invalid token — see above.
    if (!invoice || invoice.status === 'PENDING_APPROVAL') {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'This link is not valid any more. Ask the school office for a new one.',
      );
    }
    return { invoice, settings };
  }

  /**
   * What the page shows. First name only, and only the numbers a payer needs to recognise their
   * own bill — never the GR number, the guardian's phone, or anything else on the record.
   */
  async view(token: string) {
    const { invoice, settings } = await this.loadInvoice(token);
    const outstanding = Number(invoice.totalAmount) - Number(invoice.paidAmount);
    const pending = await this.db.feePaymentClaim.findFirst({
      where: { invoiceId: invoice.id, status: ClaimStatus.PENDING },
      select: { id: true, amount: true, createdAt: true },
    });
    return {
      studentFirstName: invoice.student.fullName.trim().split(/\s+/)[0],
      month: invoice.month,
      year: invoice.year,
      dueDate: invoice.dueDate,
      outstanding: outstanding.toFixed(2),
      settled: invoice.status === 'PAID' || outstanding <= 0,
      methods: settings.feeSubmission.methods,
      proofPolicy: settings.feeSubmission.proofPolicy,
      /** So the page can say "we already have your submission" instead of taking a second one. */
      pendingClaim: pending ? { submittedOn: pending.createdAt, amount: pending.amount } : null,
    };
  }

  /**
   * A presigned PUT for the proof image.
   *
   * Goes through `UploadsService`, not the storage layer directly, so a public upload gets
   * **exactly** the §22.6 pipeline every authenticated one gets: MIME allowlist, quarantine
   * prefix, magic-byte check and the ClamAV scan on confirm. A separate, simpler path for the
   * one surface strangers can reach would be precisely backwards.
   */
  async requestUpload(token: string, filename: string, mimeType: string) {
    await this.loadInvoice(token); // validate the token before handing out an upload slot
    return this.uploads.requestUpload(filename, mimeType);
  }

  /**
   * Create the claim. PENDING always — a guardian's screenshot never auto-verifies (D2), which
   * is the whole reason claims and payments are separate tables.
   */
  async submitClaim(token: string, dto: SubmitLinkClaimDto) {
    const { invoice, settings } = await this.loadInvoice(token);

    if (invoice.status === 'PAID') {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'This fee is already paid in full.');
    }
    // One at a time. Without this, a forwarded link is an unbounded write surface: anyone holding
    // it could queue hundreds of claims for the office to wade through. A guardian who genuinely
    // needs to correct a submission asks the office to reject the first.
    const pending = await this.db.feePaymentClaim.findFirst({
      where: { invoiceId: invoice.id, status: ClaimStatus.PENDING },
      select: { id: true },
    });
    if (pending) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        HttpStatus.CONFLICT,
        'A submission for this fee is already waiting to be checked. The office will be in touch.',
      );
    }
    if (!(settings.feeSubmission.methods as readonly string[]).includes(dto.method)) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'The school does not accept that payment method.',
      );
    }
    if (settings.feeSubmission.proofPolicy === 'REQUIRED' && !dto.proofFileKey) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Please attach a screenshot or photo of your payment.',
      );
    }

    // The guardian hands back the QUARANTINE key they just PUT to; promoting it is what runs the
    // magic-byte check and the virus scan. Doing it here rather than in a separate confirm call
    // means an unscanned object can never be referenced by a claim — there is no window in which
    // a row points at a file that was never validated.
    let proofFileKey = dto.proofFileKey;
    if (proofFileKey?.startsWith('quarantine/')) {
      ({ fileKey: proofFileKey } = await this.uploads.confirmUpload(proofFileKey, dto.proofMimeType ?? 'image/jpeg'));
    }

    return this.claims.submitViaLink(invoice.id, { ...dto, proofFileKey });
  }
}

export { ClaimSource };
