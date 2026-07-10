import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { ENV, type Env } from '@common';

/** Access-token claims (blueprint §22.1). */
export interface AccessClaims {
  sub: string; // userId
  sid: string; // schoolId
  roles: Role[];
  cid: string | null; // campusId
}

export interface DecodedAccess extends AccessClaims {
  iat: number;
  exp: number;
}

/**
 * Signs/verifies access JWTs with a `kid` header so two keys can be active during
 * quarterly rotation (§22.1), and mints opaque refresh tokens stored only as a
 * SHA-256 hash (§22.4 — the raw token never touches the DB).
 */
@Injectable()
export class TokenService {
  private readonly keys: Record<string, string>;
  private readonly activeKid: string;
  private readonly accessTtl: string;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.keys = env.JWT_KEYS;
    this.activeKid = env.JWT_ACTIVE_KID;
    this.accessTtl = env.JWT_ACCESS_TTL;
    if (!this.keys[this.activeKid]) {
      throw new Error(`JWT_ACTIVE_KID "${this.activeKid}" not present in JWT_KEYS`);
    }
  }

  signAccess(claims: AccessClaims): string {
    return jwt.sign(claims, this.keys[this.activeKid], {
      algorithm: 'HS256',
      expiresIn: this.accessTtl as jwt.SignOptions['expiresIn'],
      keyid: this.activeKid,
    });
  }

  /** Verify an access token, selecting the signing key by its `kid` header. */
  verifyAccess(token: string): DecodedAccess {
    const decoded = jwt.decode(token, { complete: true });
    const kid = decoded?.header?.kid;
    const secret = kid ? this.keys[kid] : undefined;
    if (!secret) throw new Error('Unknown or missing key id');
    return jwt.verify(token, secret, { algorithms: ['HS256'] }) as DecodedAccess;
  }

  /** Short-lived token proving password step passed, pending MFA (§22.5). */
  signMfaPending(userId: string, schoolId: string): string {
    return jwt.sign({ sub: userId, sid: schoolId, typ: 'mfa' }, this.keys[this.activeKid], {
      algorithm: 'HS256',
      expiresIn: '5m',
      keyid: this.activeKid,
    });
  }

  verifyMfaPending(token: string): { sub: string; sid: string } {
    const decoded = jwt.decode(token, { complete: true });
    const kid = decoded?.header?.kid;
    const secret = kid ? this.keys[kid] : undefined;
    if (!secret) throw new Error('Unknown or missing key id');
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as {
      sub: string;
      sid: string;
      typ?: string;
    };
    if (payload.typ !== 'mfa') throw new Error('Not an MFA-pending token');
    return { sub: payload.sub, sid: payload.sid };
  }

  /**
   * Platform (vendor console) access token — cross-tenant, so it carries NO `sid`.
   * `typ:'platform'` keeps it structurally distinct from tenant access tokens so one
   * can never be accepted where the other is expected (§24).
   */
  signPlatform(platformUserId: string): string {
    return jwt.sign({ sub: platformUserId, typ: 'platform' }, this.keys[this.activeKid], {
      algorithm: 'HS256',
      expiresIn: '8h',
      keyid: this.activeKid,
    });
  }

  verifyPlatform(token: string): { sub: string } {
    const decoded = jwt.decode(token, { complete: true });
    const kid = decoded?.header?.kid;
    const secret = kid ? this.keys[kid] : undefined;
    if (!secret) throw new Error('Unknown or missing key id');
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as { sub: string; typ?: string };
    if (payload.typ !== 'platform') throw new Error('Not a platform token');
    return { sub: payload.sub };
  }

  /** Opaque refresh token: return the raw value (cookie) + its hash (DB). */
  generateRefreshToken(): { raw: string; hash: string } {
    const raw = randomBytes(48).toString('base64url');
    return { raw, hash: TokenService.hashRefresh(raw) };
  }

  get refreshTtlMs(): number {
    return parseDuration(this.env.JWT_REFRESH_TTL);
  }

  get accessTtlMs(): number {
    return parseDuration(this.accessTtl);
  }

  static hashRefresh(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }
}

/** Parse a duration like "15m", "30d", "3600" into milliseconds. */
export function parseDuration(input: string): number {
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(input.trim());
  if (!m) throw new Error(`Invalid duration: ${input}`);
  const n = Number(m[1]);
  const unit = m[2] ?? 'ms';
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
  return n * mult;
}
