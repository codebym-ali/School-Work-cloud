import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Role } from '@prisma/client';

/** The authenticated principal attached after JwtAuthGuard (blueprint §19). */
export interface RequestUser {
  userId: string;
  schoolId: string;
  roles: Role[];
  campusId: string | null;
  /** SA5 break-glass: a vendor operator impersonating this school, read-only (SA-P8). */
  breakGlass?: boolean;
  /** SA5: the platform operator behind a break-glass session, for attribution. */
  vendorOperatorId?: string;
  /** Two-factor enrolled, as stamped on the access token. See `AccessClaims.mfa`. */
  mfaEnrolled?: boolean;
}

/** CLS keys — one place so producers and consumers never drift. */
export const CLS_KEYS = {
  schoolId: 'schoolId',
  planTier: 'planTier',
  user: 'user',
  ip: 'ip',
  userAgent: 'userAgent',
  /** the active tenant-bound Prisma transaction client for this request (§21.4) */
  tx: 'tx',
} as const;

/**
 * Typed accessor over CLS for the request-scoped tenant context.
 * `schoolId` is set by TenantResolutionMiddleware (pre-auth) and re-asserted
 * against the JWT by TenantScopeGuard.
 */
@Injectable()
export class TenantContext {
  constructor(private readonly cls: ClsService) {}

  get schoolId(): string | undefined {
    return this.cls.get(CLS_KEYS.schoolId);
  }

  set schoolId(value: string) {
    this.cls.set(CLS_KEYS.schoolId, value);
  }

  get planTier(): string | undefined {
    return this.cls.get(CLS_KEYS.planTier);
  }

  set planTier(value: string) {
    this.cls.set(CLS_KEYS.planTier, value);
  }

  get user(): RequestUser | undefined {
    return this.cls.get(CLS_KEYS.user);
  }

  set user(value: RequestUser) {
    this.cls.set(CLS_KEYS.user, value);
  }

  get ip(): string | undefined {
    return this.cls.get(CLS_KEYS.ip);
  }

  set ip(value: string | undefined) {
    this.cls.set(CLS_KEYS.ip, value);
  }

  get userAgent(): string | undefined {
    return this.cls.get(CLS_KEYS.userAgent);
  }

  set userAgent(value: string | undefined) {
    this.cls.set(CLS_KEYS.userAgent, value);
  }

  /** Correlation id for logs/audit (blueprint §31). */
  get requestId(): string {
    return this.cls.getId();
  }

  requireSchoolId(): string {
    const id = this.schoolId;
    if (!id) throw new Error('No tenant context (schoolId) in CLS');
    return id;
  }
}
