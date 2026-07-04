import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { authenticator } from 'otplib';
import type { Role, User } from '@prisma/client';
import {
  AppError,
  ENV,
  ErrorCodes,
  FIELD_ENCRYPTION,
  FieldEncryption,
  type Env,
  type RequestUser,
} from '@common';
import { TenantPrismaService } from '@database';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import {
  clearAuthCookies,
  setAccessCookie,
  setCsrfCookie,
  setRefreshCookie,
} from './auth.cookies';
import type {
  ChangePasswordDto,
  DisableMfaDto,
  ForgotPasswordDto,
  LoginDto,
  MfaChallengeDto,
  MfaVerifyDto,
  ResetPasswordDto,
} from './dto/auth.dto';

const MAX_FAILED = 10;
const LOCK_MS = 15 * 60 * 1000;
const MANDATORY_MFA_ROLES: Role[] = ['OWNER_ADMIN', 'ACCOUNTANT'];

export interface SessionResult {
  user: { id: string; email: string; roles: Role[]; campusId: string | null };
  mfaEnrollmentRequired?: boolean;
}
export type LoginResult = SessionResult | { mfaRequired: true; mfaToken: string };

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    @Inject(FIELD_ENCRYPTION) private readonly crypto: FieldEncryption,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  // ── Login ──────────────────────────────────────────────────────────────────
  async login(dto: LoginDto, res: Response): Promise<LoginResult> {
    const invalid = () =>
      new AppError(ErrorCodes.INVALID_CREDENTIALS, HttpStatus.UNAUTHORIZED, 'Invalid email or password');

    const user = await this.db.user.findFirst({ where: { email: dto.email.toLowerCase() } });
    // Constant-ish response: never reveal whether the email exists (§22.3).
    if (!user || user.status === 'DISABLED' || user.deletedAt || !user.passwordHash) {
      // Still spend time hashing to reduce timing signal.
      await this.passwords.verify(
        '$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        dto.password,
      );
      throw invalid();
    }

    const now = new Date();
    if (user.status === 'LOCKED') {
      if (user.lockedUntil && user.lockedUntil > now) {
        throw new AppError(ErrorCodes.ACCOUNT_LOCKED, HttpStatus.UNAUTHORIZED, 'Account locked; try later');
      }
      // Lock expired — self-heal before verifying (§22.3).
      await this.db.user.update({
        where: { id: user.id },
        data: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null },
      });
      user.failedLoginCount = 0;
      user.status = 'ACTIVE';
    }

    const ok = await this.passwords.verify(user.passwordHash, dto.password);
    if (!ok) {
      await this.registerFailure(user);
      throw invalid();
    }

    if (user.failedLoginCount > 0) {
      await this.db.user.update({ where: { id: user.id }, data: { failedLoginCount: 0 } });
    }

    if (user.mfaEnabled) {
      return { mfaRequired: true, mfaToken: this.tokens.signMfaPending(user.id, user.schoolId) };
    }

    await this.db.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
    return this.issueSession(user, res);
  }

  private async registerFailure(user: User): Promise<void> {
    const failed = user.failedLoginCount + 1;
    if (failed >= MAX_FAILED) {
      await this.db.user.update({
        where: { id: user.id },
        data: { failedLoginCount: failed, status: 'LOCKED', lockedUntil: new Date(Date.now() + LOCK_MS) },
      });
    } else {
      await this.db.user.update({ where: { id: user.id }, data: { failedLoginCount: failed } });
    }
  }

  // ── MFA challenge (step 2 of two-step login) ────────────────────────────────
  async mfaChallenge(dto: MfaChallengeDto, res: Response): Promise<SessionResult> {
    let sub: string;
    try {
      ({ sub } = this.tokens.verifyMfaPending(dto.mfaToken));
    } catch {
      throw new AppError(ErrorCodes.MFA_INVALID, HttpStatus.UNAUTHORIZED, 'MFA session expired');
    }
    const user = await this.db.user.findFirst({ where: { id: sub } });
    if (!user || !user.mfaEnabled || !user.mfaSecretEnc) {
      throw new AppError(ErrorCodes.MFA_INVALID, HttpStatus.UNAUTHORIZED, 'MFA not available');
    }
    const secret = this.crypto.decrypt(user.mfaSecretEnc);
    if (!authenticator.verify({ token: dto.code, secret })) {
      throw new AppError(ErrorCodes.MFA_INVALID, HttpStatus.UNAUTHORIZED, 'Invalid MFA code');
    }
    await this.db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return this.issueSession(user, res);
  }

  // ── Session issuance ────────────────────────────────────────────────────────
  private async issueSession(user: User, res: Response): Promise<SessionResult> {
    const claims = { sub: user.id, sid: user.schoolId, roles: user.roles, cid: user.campusId };
    const access = this.tokens.signAccess(claims);

    const { raw, hash } = this.tokens.generateRefreshToken();
    const familyId = randomUUID();
    await this.db.refreshToken.create({
      data: {
        schoolId: user.schoolId,
        userId: user.id,
        tokenHash: hash,
        familyId,
        expiresAt: new Date(Date.now() + this.tokens.refreshTtlMs),
      },
    });

    const csrf = randomBytes(24).toString('base64url');
    setAccessCookie(res, this.env, access, this.tokens.accessTtlMs);
    setRefreshCookie(res, this.env, raw, this.tokens.refreshTtlMs);
    setCsrfCookie(res, this.env, csrf);

    const mfaEnrollmentRequired =
      !user.mfaEnabled && user.roles.some((r) => MANDATORY_MFA_ROLES.includes(r));

    return {
      user: { id: user.id, email: user.email, roles: user.roles, campusId: user.campusId },
      ...(mfaEnrollmentRequired ? { mfaEnrollmentRequired: true } : {}),
    };
  }

  // ── Refresh rotation (§22.4) ────────────────────────────────────────────────
  async refresh(rawRefresh: string | undefined, res: Response): Promise<SessionResult> {
    const fail = () =>
      new AppError(ErrorCodes.REFRESH_INVALID, HttpStatus.UNAUTHORIZED, 'Invalid refresh token');
    if (!rawRefresh) throw fail();

    const hash = TokenService.hashRefresh(rawRefresh);
    const existing = await this.db.refreshToken.findFirst({ where: { tokenHash: hash } });
    if (!existing) throw fail();

    // Reuse of an already-revoked token => theft signal: revoke the whole family.
    if (existing.revokedAt) {
      await this.db.refreshToken.updateMany({
        where: { familyId: existing.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.warn({ userId: existing.userId, familyId: existing.familyId }, 'REFRESH_REUSE_DETECTED');
      throw fail();
    }
    if (existing.expiresAt < new Date()) throw fail();

    const user = await this.db.user.findFirst({ where: { id: existing.userId } });
    if (!user || user.status === 'DISABLED' || user.deletedAt) throw fail();

    // Rotate: revoke the used token, mint a new one in the same family.
    await this.db.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });
    const { raw, hash: newHash } = this.tokens.generateRefreshToken();
    await this.db.refreshToken.create({
      data: {
        schoolId: user.schoolId,
        userId: user.id,
        tokenHash: newHash,
        familyId: existing.familyId,
        expiresAt: new Date(Date.now() + this.tokens.refreshTtlMs),
      },
    });

    const access = this.tokens.signAccess({
      sub: user.id,
      sid: user.schoolId,
      roles: user.roles,
      cid: user.campusId,
    });
    const csrf = randomBytes(24).toString('base64url');
    setAccessCookie(res, this.env, access, this.tokens.accessTtlMs);
    setRefreshCookie(res, this.env, raw, this.tokens.refreshTtlMs);
    setCsrfCookie(res, this.env, csrf);

    return { user: { id: user.id, email: user.email, roles: user.roles, campusId: user.campusId } };
  }

  async logout(rawRefresh: string | undefined, res: Response): Promise<void> {
    if (rawRefresh) {
      const hash = TokenService.hashRefresh(rawRefresh);
      const existing = await this.db.refreshToken.findFirst({ where: { tokenHash: hash } });
      if (existing) {
        await this.db.refreshToken.updateMany({
          where: { familyId: existing.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
    }
    clearAuthCookies(res, this.env);
  }

  // ── Password change / reset ─────────────────────────────────────────────────
  async changePassword(principal: RequestUser, dto: ChangePasswordDto): Promise<void> {
    const user = await this.db.user.findFirst({ where: { id: principal.userId } });
    if (!user || !user.passwordHash || !(await this.passwords.verify(user.passwordHash, dto.currentPassword))) {
      throw new AppError(ErrorCodes.INVALID_CREDENTIALS, HttpStatus.UNAUTHORIZED, 'Current password is wrong');
    }
    if (dto.newPassword.length < 10) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Password too short');
    }
    await this.passwords.isPwned(dto.newPassword); // soft-fail; logged in service
    const hash = await this.passwords.hash(dto.newPassword);
    await this.db.user.update({
      where: { id: user.id },
      data: { passwordHash: hash, passwordChangedAt: new Date() },
    });
    // Revoke all refresh families (§22.3).
    await this.db.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async forgotPassword(dto: ForgotPasswordDto): Promise<void> {
    const user = await this.db.user.findFirst({ where: { email: dto.email.toLowerCase() } });
    if (user) {
      const raw = randomBytes(32).toString('base64url');
      await this.db.passwordResetToken.create({
        data: {
          schoolId: user.schoolId,
          userId: user.id,
          tokenHash: TokenService.hashRefresh(raw),
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      });
      // TODO(M3): dispatch reset link via SMS/email adapter. For now, log for dev only.
      this.logger.debug({ userId: user.id }, 'Password reset token issued (delivery pending M3 comms)');
    }
    // Always 200 — never reveal whether the email exists.
  }

  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const hash = TokenService.hashRefresh(dto.token);
    const record = await this.db.passwordResetToken.findFirst({ where: { tokenHash: hash } });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Invalid or expired token');
    }
    const newHash = await this.passwords.hash(dto.newPassword);
    await this.db.user.update({
      where: { id: record.userId },
      data: { passwordHash: newHash, passwordChangedAt: new Date(), status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null },
    });
    await this.db.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    await this.db.refreshToken.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // ── MFA enrolment (§22.5) ───────────────────────────────────────────────────
  async mfaSetup(principal: RequestUser): Promise<{ otpauthUrl: string }> {
    const user = await this.db.user.findFirst({ where: { id: principal.userId } });
    if (!user) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'User not found');
    const secret = authenticator.generateSecret();
    await this.db.user.update({
      where: { id: user.id },
      data: { mfaSecretEnc: this.crypto.encrypt(secret), mfaEnabled: false },
    });
    const otpauthUrl = authenticator.keyuri(user.email, 'SchoolMS', secret);
    return { otpauthUrl };
  }

  async mfaVerify(principal: RequestUser, dto: MfaVerifyDto): Promise<void> {
    const user = await this.db.user.findFirst({ where: { id: principal.userId } });
    if (!user?.mfaSecretEnc) {
      throw new AppError(ErrorCodes.MFA_INVALID, HttpStatus.UNPROCESSABLE_ENTITY, 'Start MFA setup first');
    }
    const secret = this.crypto.decrypt(user.mfaSecretEnc);
    if (!authenticator.verify({ token: dto.code, secret })) {
      throw new AppError(ErrorCodes.MFA_INVALID, HttpStatus.UNPROCESSABLE_ENTITY, 'Invalid MFA code');
    }
    await this.db.user.update({ where: { id: user.id }, data: { mfaEnabled: true } });
    // TODO(§22.5): issue 10 single-use recovery codes (needs a recovery_codes table).
  }

  async disableMfa(principal: RequestUser, dto: DisableMfaDto): Promise<void> {
    const user = await this.db.user.findFirst({ where: { id: principal.userId } });
    if (!user?.passwordHash || !user.mfaSecretEnc || !(await this.passwords.verify(user.passwordHash, dto.password))) {
      throw new AppError(ErrorCodes.INVALID_CREDENTIALS, HttpStatus.UNAUTHORIZED, 'Password or code invalid');
    }
    const secret = this.crypto.decrypt(user.mfaSecretEnc);
    if (!authenticator.verify({ token: dto.code, secret })) {
      throw new AppError(ErrorCodes.MFA_INVALID, HttpStatus.UNAUTHORIZED, 'Invalid MFA code');
    }
    await this.db.user.update({
      where: { id: user.id },
      data: { mfaEnabled: false, mfaSecretEnc: null },
    });
  }

  async me(principal: RequestUser): Promise<{ id: string; email: string; roles: Role[]; campusId: string | null }> {
    const user = await this.db.user.findFirst({ where: { id: principal.userId } });
    if (!user) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'User not found');
    return { id: user.id, email: user.email, roles: user.roles, campusId: user.campusId };
  }
}
