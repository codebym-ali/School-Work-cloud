import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import { AppError, ENV, ErrorCodes, type Env } from '@common';
import { PlatformPrismaService } from '@database';
import { PasswordService } from '../auth/password.service';
import { TokenService } from '../auth/token.service';
import {
  clearPlatformCookies,
  setPlatformAccessCookie,
  setPlatformCsrfCookie,
} from './platform.cookies';
import type { PlatformLoginDto } from './dto/platform.dto';

const ACCESS_TTL_MS = 8 * 60 * 60 * 1000; // 8h console session

export interface PlatformPrincipal {
  id: string;
  email: string;
}

/**
 * Vendor-console authentication (blueprint §24). Authenticates against `platform_users`
 * (no tenant, no RLS) and issues a platform-scoped session. Argon2id + the constant-time
 * "always hash" pattern from tenant auth (§22.3), so the response never reveals whether
 * an email exists.
 */
@Injectable()
export class PlatformAuthService {
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
    this.issueSession(res, user.id);
    return { user: { id: user.id, email: user.email } };
  }

  async me(id: string): Promise<PlatformPrincipal> {
    const user = await this.platform.platformUser.findUnique({ where: { id } });
    if (!user) throw new AppError(ErrorCodes.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, 'Not authenticated');
    return { id: user.id, email: user.email };
  }

  logout(res: Response): void {
    clearPlatformCookies(res, this.env);
  }

  private issueSession(res: Response, platformUserId: string): void {
    const access = this.tokens.signPlatform(platformUserId);
    const csrf = randomBytes(32).toString('base64url');
    setPlatformAccessCookie(res, this.env, access, ACCESS_TTL_MS);
    setPlatformCsrfCookie(res, this.env, csrf);
  }
}
