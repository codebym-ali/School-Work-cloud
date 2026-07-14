import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { AppError, ENV, ErrorCodes, restrictedCampusId, TenantContext, type Env } from '@common';
import { TenantPrismaService } from '@database';
import { SMS_GATEWAY, type SmsGateway } from '../comms/sms/sms-gateway';

const OTP_TTL_MS = 10 * 60 * 1000; // code valid 10 minutes
const MAX_ATTEMPTS = 5; // wrong guesses before a new code is required
const RESEND_COOLDOWN_MS = 60 * 1000; // min gap between sends (anti-SMS-bomb)

/**
 * Guardian phone verification via SMS OTP (blueprint §14). Guardian SMS (absence, fee
 * receipt, results…) is gated on `phoneVerifiedAt` — an unverified number never receives
 * student PII — so this is the flow that turns a number "on". Admin-initiated: an admin
 * sends the code to the guardian's phone and enters what the guardian reads back.
 *
 * The code is stored only as an HMAC (never plaintext), expires in 10 min, and is
 * attempt-limited; verifying sets `phoneVerifiedAt` and clears the challenge.
 */
@Injectable()
export class PhoneVerificationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    @Inject(ENV) private readonly env: Env,
    @Inject(SMS_GATEWAY) private readonly gateway: SmsGateway,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  private hash(code: string): string {
    return createHmac('sha256', this.env.ENCRYPTION_MASTER_KEY).update(code).digest('hex');
  }

  async request(parentId: string): Promise<{ sentTo: string; expiresInSeconds: number }> {
    const parent = await this.loadScopedParent(parentId);
    if (parent.phoneVerifiedAt) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Phone is already verified');
    }
    // Resend cooldown so the endpoint can't be used to spam a number with SMS.
    const issuedAt = parent.otpExpiresAt ? parent.otpExpiresAt.getTime() - OTP_TTL_MS : 0;
    if (parent.otpExpiresAt && Date.now() - issuedAt < RESEND_COOLDOWN_MS) {
      throw new AppError(ErrorCodes.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, 'A code was just sent — wait a minute before requesting another');
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db.parentProfile.update({
      where: { id: parentId },
      data: { otpCodeHash: this.hash(code), otpExpiresAt: new Date(Date.now() + OTP_TTL_MS), otpAttempts: 0 },
    });

    const school = await this.db.school.findFirst({ where: { id: this.ctx.requireSchoolId() }, select: { name: true } });
    await this.gateway.send(parent.phone, `${code} is your ${school?.name ?? 'school'} verification code. Valid 10 minutes.`);
    return { sentTo: maskPhone(parent.phone), expiresInSeconds: OTP_TTL_MS / 1000 };
  }

  async confirm(parentId: string, code: string): Promise<{ verified: true }> {
    const parent = await this.loadScopedParent(parentId);
    if (parent.phoneVerifiedAt) return { verified: true };
    if (!parent.otpCodeHash || !parent.otpExpiresAt || parent.otpExpiresAt.getTime() < Date.now()) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'No active code — request a new one');
    }
    if (parent.otpAttempts >= MAX_ATTEMPTS) {
      throw new AppError(ErrorCodes.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, 'Too many attempts — request a new code');
    }
    if (!constantTimeEquals(this.hash(code), parent.otpCodeHash)) {
      await this.db.parentProfile.update({ where: { id: parentId }, data: { otpAttempts: { increment: 1 } } });
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Incorrect code');
    }
    await this.db.parentProfile.update({
      where: { id: parentId },
      data: { phoneVerifiedAt: new Date(), otpCodeHash: null, otpExpiresAt: null, otpAttempts: 0 },
    });
    return { verified: true };
  }

  /**
   * Load the parent, enforcing campus scoping (§22.8, P1.7): a campus-bound admin may only
   * act on a parent who guardians a student with an ACTIVE enrollment in their campus.
   */
  private async loadScopedParent(parentId: string) {
    const parent = await this.db.parentProfile.findFirst({ where: { id: parentId } });
    if (!parent) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Parent not found');
    const restricted = restrictedCampusId(this.ctx.user);
    if (restricted !== null) {
      const inCampus = await this.db.studentGuardian.findFirst({
        where: { parentId, student: { enrollments: { some: { status: 'ACTIVE', campusId: restricted } } } },
        select: { id: true },
      });
      if (!inCampus) throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Parent belongs to another campus');
    }
    return parent;
  }
}

/** Timing-safe compare of two equal-length hex digests. */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function maskPhone(phone: string): string {
  return phone.length <= 4 ? '****' : phone.slice(0, -4).replace(/[0-9]/g, '*') + phone.slice(-4);
}
