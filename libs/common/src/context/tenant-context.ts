import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Role } from '@prisma/client';

/** The authenticated principal attached after JwtAuthGuard (blueprint §19). */
export interface RequestUser {
  userId: string;
  schoolId: string;
  roles: Role[];
  campusId: string | null;
}

/** CLS keys — one place so producers and consumers never drift. */
export const CLS_KEYS = {
  schoolId: 'schoolId',
  planTier: 'planTier',
  user: 'user',
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
