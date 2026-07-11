import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { AppError, ENV, ErrorCodes, type Env } from '@common';
import { PlatformPrismaService } from '@database';
import { PasswordService } from '../auth/password.service';
import { TokenService } from '../auth/token.service';
import {
  clearPlatformCookies,
  setPlatformAccessCookie,
  setPlatformCsrfCookie,
  setPlatformRefreshCookie,
} from './platform.cookies';
import type { PlatformLoginDto } from './dto/platform.dto';

export interface PlatformPrincipal {
  id: string;
  email: string;
}

/**
 * Vendor-console authentication (blueprint §24). Authenticates against `platform_users`
 * (no tenant, no RLS) and issues a platform-scoped session: a short access token (15m)
 * plus a single-use **rotating** refresh token (family-reuse detection = theft signal),
 * mirroring tenant auth (§22.4). Argon2id + the constant-time "always hash" pattern so
 * the response never reveals whether an email exists.
 */
@Injectable()
export class PlatformAuthService {
  private readonly logger = new Logger(PlatformAuthService.name);

  constructor(
    private readonly platform: PlatformPrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async login(dto: PlatformLoginDto, res: Response): Promise<{ user: PlatformPrincipal }> {
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

    await this.platform.platformUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.issueSession(res, user.id, randomUUID()); // new rotation family
    return { user: { id: user.id, email: user.email } };
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
    return { user: { id: user.id, email: user.email } };
  }

  async me(id: string): Promise<PlatformPrincipal> {
    const user = await this.platform.platformUser.findUnique({ where: { id } });
    if (!user) throw new AppError(ErrorCodes.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, 'Not authenticated');
    return { id: user.id, email: user.email };
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
}
