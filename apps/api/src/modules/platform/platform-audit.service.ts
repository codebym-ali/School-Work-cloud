import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PlatformPrismaService } from '@database';

export interface PlatformAuditInput {
  /** The operator who performed the action (from the platform session), or `null` for a SYSTEM
   *  action with no operator (SA6b automated jobs — auto-invoice, dunning auto-suspend). */
  platformUserId: string | null;
  /** A stable, screaming-snake verb, e.g. `TENANT_PROVISION` / `TENANT_SUSPEND`. */
  action: string;
  /** The tenant the action targeted, when there is one. */
  targetTenantId?: string;
  /** Structured, non-sensitive detail about the action (never credentials). */
  metadata?: Prisma.InputJsonValue;
  /** Mandatory human reason on destructive actions (SA-P2). */
  reason?: string;
  /** Caller IP, best-effort, for the trail. */
  ip?: string;
}

/**
 * The vendor-console audit trail (SA0, SA-P2). Every platform WRITE calls `record()` so the
 * console can always answer who did what, to which tenant, when — and why, on destructive
 * actions. Writes on the platform_admin (BYPASSRLS) connection: `platform_audit_logs` is a
 * NON-tenant table (no school_id, no RLS), so it lives on the same client as the rest of the
 * console.
 */
@Injectable()
export class PlatformAuditService {
  constructor(private readonly platform: PlatformPrismaService) {}

  async record(input: PlatformAuditInput): Promise<void> {
    await this.platform.platformAuditLog.create({
      data: {
        platformUserId: input.platformUserId,
        action: input.action,
        targetTenantId: input.targetTenantId ?? null,
        metadata: input.metadata,
        reason: input.reason ?? null,
        ip: input.ip ?? null,
      },
    });
  }
}
