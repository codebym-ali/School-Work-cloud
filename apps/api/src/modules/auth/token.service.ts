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
  /** SA5 break-glass: marks a vendor "login-as" session (read-only, scoped to `sid`). */
  bg?: boolean;
  /** SA5: the platform operator behind a break-glass session, for attribution. */
  vop?: string;
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

  /**
   * A break-glass access token (SA5): a NORMAL tenant access token scoped to ONE school (`sid`),
   * so it rides the same RLS-bound request path and is confined to that tenant by TenantScopeGuard
   * (host mismatch → 403) + RLS — NEVER the BYPASSRLS connection (SA-P8). Marked `bg` so the pipeline
   * attaches the acting vendor operator and enforces read-only. Short-lived (30 min).
   */
  signBreakGlass(vendorOperatorId: string, schoolId: string): { token: string; expiresInSec: number } {
    const expiresInSec = 30 * 60;
    const token = jwt.sign(
      { sub: vendorOperatorId, sid: schoolId, roles: ['OWNER_ADMIN'], cid: null, bg: true, vop: vendorOperatorId },
      this.keys[this.activeKid],
      { algorithm: 'HS256', expiresIn: expiresInSec, keyid: this.activeKid },
    );
    return { token, expiresInSec };
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
      expiresIn: this.accessTtl as jwt.SignOptions['expiresIn'], // short (15m) — a refresh token now rotates the session
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

  /**
   * Short-lived token proving the platform password step passed, pending MFA (SA0). The
   * platform equivalent of `signMfaPending`: `typ:'platform-mfa'` keeps it structurally
   * distinct from the tenant MFA-pending token AND the full platform access token, so one
   * can never be redeemed where another is expected. Carries no `sid` — platform is
   * cross-tenant.
   */
  signPlatformMfaPending(platformUserId: string): string {
    return jwt.sign({ sub: platformUserId, typ: 'platform-mfa' }, this.keys[this.activeKid], {
      algorithm: 'HS256',
      expiresIn: '5m',
      keyid: this.activeKid,
    });
  }

  verifyPlatformMfaPending(token: string): { sub: string } {
    const decoded = jwt.decode(token, { complete: true });
    const kid = decoded?.header?.kid;
    const secret = kid ? this.keys[kid] : undefined;
    if (!secret) throw new Error('Unknown or missing key id');
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as { sub: string; typ?: string };
    if (payload.typ !== 'platform-mfa') throw new Error('Not a platform-MFA-pending token');
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
