import { Injectable } from '@nestjs/common';
import { TenantContext, type AuditAction } from '@common';
import { TenantPrismaService } from './tenant-prisma.service';

export interface AuditInput {
  action: AuditAction;
  entityType: string;
  entityId: string;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string;
  /** Override the actor (e.g. background jobs). Defaults to the request user. */
  actorId?: string;
}

/**
 * Writes AuditLog rows for sensitive mutations (blueprint §34 PR checklist,
 * Appendix B). Runs on the tenant-bound client, so the row is tenant-scoped and
 * carries the request's actor, ip, userAgent, and correlation id.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
  ) {}

  async record(input: AuditInput): Promise<void> {
    const actorId = input.actorId ?? this.ctx.user?.userId;
    if (!actorId) throw new Error(`AuditService.record: no actor for action ${input.action}`);

    await this.tenantPrisma.client.auditLog.create({
      data: {
        schoolId: this.ctx.requireSchoolId(),
        userId: actorId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        oldValue: (input.oldValue ?? undefined) as never,
        newValue: (input.newValue ?? undefined) as never,
        reason: input.reason,
        ip: this.ctx.ip,
        userAgent: this.ctx.userAgent,
        requestId: this.ctx.requestId,
      },
    });
  }
}
