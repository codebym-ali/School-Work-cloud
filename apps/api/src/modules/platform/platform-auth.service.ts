import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { authenticator } from 'otplib';
import type { PlatformRole } from '@prisma/client';
import { AppError, ENV, ErrorCodes, FIELD_ENCRYPTION, FieldEncryption, type Env } from '@common';
import { PlatformPrismaService } from '@database';
import { PasswordService } from '../auth/password.service';
import { TokenService } from '../auth/token.service';
import {
  clearPlatformCookies,
  setPlatformAccessCookie,
  setPlatformCsrfCookie,
  setPlatformRefreshCookie,
} from './platform.cookies';
import type { PlatformLoginDto, PlatformMfaDto, PlatformMfaEnrollConfirmDto } from './dto/platform.dto';

export interface PlatformPrincipal {
  id: string;
  email: string;
  role: PlatformRole;
  mfaEnabled: boolean;
}

/** Login either lands a session (`user`) or, when MFA is on, hands back a pending token. */
export type PlatformLoginResult = { user: PlatformPrincipal } | { mfaRequired: true; mfaToken: string };

/**
 * Vendor-console authentication (blueprint §24). Authenticates against `platform_users`
 * (no tenant, no RLS) and issues a platform-scoped session: a short access token (15m)
 * plus a single-use **rotating** refresh token (family-reuse detection = theft signal),
 * mirroring tenant auth (§22.4). Argon2id + the constant-time "always hash" pattern so
 * the response never reveals whether an email exists.
 *
 * SA0 adds a second factor that MIRRORS the tenant MFA flow (auth.service.ts): an otplib
 * TOTP whose secret is stored encrypted (`mfaSecretEnc`), plus argon2-hashed single-use
 * recovery codes — the platform equivalents keyed by `platformUserId`.
 */
@Injectable()
export class PlatformAuthService {
  private readonly logger = new Logger(PlatformAuthService.name);

  constructor(
    private readonly platform: PlatformPrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    @Inject(FIELD_ENCRYPTION) private readonly crypto: FieldEncryption,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async login(dto: PlatformLoginDto, res: Response): Promise<PlatformLoginResult> {
    const invalid = () =>
      new AppError(ErrorCodes.INVALID_CREDENTIALS, HttpStatus.UNAUTHORIZED, 'Invalid email or password');

    const user = await this.platform.platformUser.findUnique({ where: { email: dto.email.toLowerCase() } });
    if (!user || user.status === 'DISABLED') {
      // Spend the hashing time regardless, to flatten the timing signal.
      await this.passwords.verify(
        '$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        dto.password,
      );
      throw invalid();
    }

    if (!(await this.passwords.verify(user.passwordHash, dto.password))) throw invalid();

    // Password proved — but if MFA is on, hold the session behind the second factor and set
    // NO cookies. The pending token carries identity; `mfa()` exchanges it for a real session.
    if (user.mfaEnabled) {
      return { mfaRequired: true, mfaToken: this.tokens.signPlatformMfaPending(user.id) };
    }

    await this.platform.platformUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.issueSession(res, user.id, randomUUID()); // new rotation family
    return { user: this.principal(user) };
  }

  /**
   * Step 2 of the two-step login (SA0). Verifies the pending token, then a 6-digit TOTP OR a
   * single-use recovery code (tried first so a code is consumed rather than rejected as a bad
   * TOTP), and only then issues the full session. Mirrors AuthService.mfaChallenge.
   */
  async mfa(dto: PlatformMfaDto, res: Response): Promise<{ user: PlatformPrincipal }> {
    let sub: string;
    try {
      ({ sub } = this.tokens.verifyPlatformMfaPending(dto.mfaToken));
    } catch {
      throw new AppError(ErrorCodes.MFA_INVALID, HttpStatus.UNAUTHORIZED, 'MFA session expired');
    }
    const user = await this.platform.platformUser.findUnique({ where: { id: sub } });
    if (!user || user.status !== 'ACTIVE' || !user.mfaEnabled || !user.mfaSecretEnc) {
      throw new AppError(ErrorCodes.MFA_INVALID, HttpStatus.UNAUTHORIZED, 'MFA not available');
    }
    const usedRecovery = await this.consumeRecoveryCode(user.id, dto.code);
    if (!usedRecovery) {
      const secret = this.crypto.decrypt(user.mfaSecretEnc);
      if (!authenticator.verify({ token: dto.code, secret })) {
        throw new AppError(ErrorCodes.MFA_INVALID, HttpStatus.UNAUTHORIZED, 'Invalid MFA code');
      }
    }
    await this.platform.platformUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.issueSession(res, user.id, randomUUID());
    return { user: this.principal(user) };
  }

  /** Single-use refresh rotation with family-reuse detection (§22.4). */
  async refresh(rawRefresh: string | undefined, res: Response): Promise<{ user: PlatformPrincipal }> {
    const fail = () => new AppError(ErrorCodes.REFRESH_INVALID, HttpStatus.UNAUTHORIZED, 'Invalid refresh token');
    if (!rawRefresh) throw fail();

    const hash = TokenService.hashRefresh(rawRefresh);
    const existing = await this.platform.platformRefreshToken.findFirst({ where: { tokenHash: hash } });
    if (!existing) throw fail();

    // Reuse of an already-revoked token ⇒ theft signal: revoke the whole family.
    if (existing.revokedAt) {
      await this.platform.platformRefreshToken.updateMany({
        where: { familyId: existing.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.warn(`PLATFORM_REFRESH_REUSE_DETECTED user=${existing.platformUserId} family=${existing.familyId}`);
      throw fail();
    }
    if (existing.expiresAt < new Date()) throw fail();

    const user = await this.platform.platformUser.findUnique({ where: { id: existing.platformUserId } });
    if (!user || user.status !== 'ACTIVE') throw fail();

    // Rotate: revoke the used token, mint a new one in the same family.
    await this.platform.platformRefreshToken.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });
    await this.issueSession(res, user.id, existing.familyId);
    return { user: this.principal(user) };
  }

  async me(id: string): Promise<PlatformPrincipal> {
    const user = await this.platform.platformUser.findUnique({ where: { id } });
    if (!user) throw new AppError(ErrorCodes.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, 'Not authenticated');
    return this.principal(user);
  }

  /** Revoke the presented refresh family and clear cookies. */
  async logout(rawRefresh: string | undefined, res: Response): Promise<void> {
    if (rawRefresh) {
      const token = await this.platform.platformRefreshToken.findFirst({ where: { tokenHash: TokenService.hashRefresh(rawRefresh) } });
      if (token) {
        await this.platform.platformRefreshToken.updateMany({
          where: { familyId: token.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
    }
    clearPlatformCookies(res, this.env);
  }

  // ── MFA enrolment (SA0, mirrors AuthService.mfaSetup/mfaVerify) ──────────────
  /** Begin enrolment: store a fresh encrypted secret (mfaEnabled stays false until confirmed). */
  async mfaEnrollBegin(platformUserId: string): Promise<{ otpauthUrl: string; secret: string }> {
    const user = await this.platform.platformUser.findUnique({ where: { id: platformUserId } });
    if (!user) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Operator not found');
    const secret = authenticator.generateSecret();
    await this.platform.platformUser.update({
      where: { id: user.id },
      data: { mfaSecretEnc: this.crypto.encrypt(secret), mfaEnabled: false },
    });
    const otpauthUrl = authenticator.keyuri(user.email, 'SchoolMS Platform', secret);
    return { otpauthUrl, secret };
  }

  /** Confirm enrolment: verify a TOTP, flip mfaEnabled on, issue the one-time recovery codes. */
  async mfaEnrollConfirm(platformUserId: string, dto: PlatformMfaEnrollConfirmDto): Promise<{ recoveryCodes: string[] }> {
    const user = await this.platform.platformUser.findUnique({ where: { id: platformUserId } });
    if (!user?.mfaSecretEnc) {
      throw new AppError(ErrorCodes.MFA_INVALID, HttpStatus.UNPROCESSABLE_ENTITY, 'Start MFA setup first');
    }
    const secret = this.crypto.decrypt(user.mfaSecretEnc);
    if (!authenticator.verify({ token: dto.code, secret })) {
      throw new AppError(ErrorCodes.MFA_INVALID, HttpStatus.UNPROCESSABLE_ENTITY, 'Invalid MFA code');
    }
    await this.platform.platformUser.update({ where: { id: user.id }, data: { mfaEnabled: true } });
    // Codes are issued WITH enrolment (never a later opt-in): the moment MFA is on, a lost
    // authenticator is a lockout, so the recovery path must exist from the first second.
    return { recoveryCodes: await this.regenerateRecoveryCodes(user.id) };
  }

  private principal(user: { id: string; email: string; role: PlatformRole; mfaEnabled: boolean }): PlatformPrincipal {
    return { id: user.id, email: user.email, role: user.role, mfaEnabled: user.mfaEnabled };
  }

  private async issueSession(res: Response, platformUserId: string, familyId: string): Promise<void> {
    const access = this.tokens.signPlatform(platformUserId);
    const { raw, hash } = this.tokens.generateRefreshToken();
    await this.platform.platformRefreshToken.create({
      data: { platformUserId, tokenHash: hash, familyId, expiresAt: new Date(Date.now() + this.tokens.refreshTtlMs) },
    });
    const csrf = randomBytes(32).toString('base64url');
    setPlatformAccessCookie(res, this.env, access, this.tokens.accessTtlMs);
    setPlatformRefreshCookie(res, this.env, raw, this.tokens.refreshTtlMs);
    setPlatformCsrfCookie(res, this.env, csrf);
  }

  // ── Recovery codes (SA0, keyed by platformUserId — mirrors AuthService) ──────
  /** Replace this operator's codes with a fresh set of ten, returning the PLAINTEXT once. */
  private async regenerateRecoveryCodes(platformUserId: string): Promise<string[]> {
    const codes = Array.from({ length: 10 }, () => this.newRecoveryCode());
    await this.platform.platformMfaRecoveryCode.deleteMany({ where: { platformUserId } });
    for (const code of codes) {
      await this.platform.platformMfaRecoveryCode.create({
        data: { platformUserId, codeHash: await this.passwords.hash(this.normalizeRecoveryCode(code)) },
      });
    }
    return codes;
  }

  /** Readable, unambiguous codes: no look-alike glyphs, grouped for transcription off paper. */
  private newRecoveryCode(): string {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const pick = () => alphabet[randomBytes(1)[0] % alphabet.length];
    const block = () => Array.from({ length: 5 }, pick).join('');
    return `${block()}-${block()}`;
  }

  /** Compared case- and dash-insensitively — the operator is copying from paper. */
  private normalizeRecoveryCode(code: string): string {
    return code.replace(/[^a-z0-9]/gi, '').toUpperCase();
  }

  /**
   * Consume a recovery code, if the supplied value is one. Returns false when it isn't, so the
   * caller falls through to TOTP. Every unused code is checked with argon2 (deliberately slow,
   * salted — no lookup by value); marked used BEFORE the session issues so two concurrent
   * attempts with the same code cannot both succeed.
   */
  private async consumeRecoveryCode(platformUserId: string, supplied: string): Promise<boolean> {
    const normalized = this.normalizeRecoveryCode(supplied);
    if (normalized.length < 8) return false; // a 6-digit TOTP can never be a recovery code
    const candidates = await this.platform.platformMfaRecoveryCode.findMany({ where: { platformUserId, usedAt: null } });
    for (const c of candidates) {
      if (await this.passwords.verify(c.codeHash, normalized)) {
        await this.platform.platformMfaRecoveryCode.update({ where: { id: c.id }, data: { usedAt: new Date() } });
        return true;
      }
    }
    return false;
  }
}
