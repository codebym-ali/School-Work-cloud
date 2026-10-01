import { Global, Injectable, Module } from '@nestjs/common';
import type { Response } from 'express';
import { AuditActions, TenantContext } from '@common';
import { AuditService, TenantPrismaService } from '@database';

/** What a proposing caller gets back instead of the change having happened. */
export interface ProposalResult { pendingApproval: true; approvalId: string; message: string }

export const PENDING_APPROVAL_HEADER = 'x-pending-approval';

type Exec<P, R> = (payload: P) => Promise<R>;

/**
 * School-wide setup changes: the Ops Admin PROPOSES, the owner APPROVES (Campus Ops Admin plan, phase 5).
 *
 * A setup action is wrapped once, where its controller is built:
 *
 *     this.addHead = proposals.action('feeHead.create', (dto) => setup.createHead(dto), (dto) => `Add fee head “${dto.name}”`);
 *
 * Called by the OWNER, it simply runs. Called by anyone else who reached the route (the Ops Admin), nothing changes:
 * a PENDING `SETUP_CHANGE` request is stored holding the action key and its (already validated) payload, and the
 * caller is told it is waiting. When the owner approves, the SAME executor runs with the stored payload — one
 * implementation, so a proposal can never do anything the direct call would not.
 *
 * The registry is explicit (an allow-list of action keys), never a replay of arbitrary HTTP: an approval can run
 * only what a controller deliberately registered.
 *
 * ⚠️ Headers, not status codes: a `@HttpCode(204)` DELETE has no body, and Nest re-applies the declared status after
 * the handler, so a 202 cannot be signalled there. `x-pending-approval` works for every verb; the body carries the
 * same facts for verbs that have one.
 */
@Injectable()
export class ProposalsService {
  private readonly executors = new Map<string, Exec<never, unknown>>();

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  /** Register an executor and get back the actor-aware entry point for controllers to call. */
  action<P, R>(key: string, exec: Exec<P, R>, label: (payload: P) => string) {
    this.executors.set(key, exec as Exec<never, unknown>);
    return async (payload: P, res?: Response): Promise<R | ProposalResult> => {
      if (this.ctx.user?.roles.includes('OWNER_ADMIN')) return exec(payload); // the approver acts directly
      return this.propose(key, label(payload), payload, res);
    };
  }

  /** Run a stored proposal — only ever called by the owner's approval. */
  async execute(key: string, payload: unknown): Promise<unknown> {
    const exec = this.executors.get(key);
    if (!exec) throw new Error(`Unknown setup action ${key}`);
    return (exec as Exec<unknown, unknown>)(payload);
  }

  isKnown(key: string): boolean {
    return this.executors.has(key);
  }

  private async propose(key: string, label: string, payload: unknown, res?: Response): Promise<ProposalResult> {
    const user = this.ctx.user!;
    const created = await this.db.approvalRequest.create({
      data: {
        schoolId: this.ctx.requireSchoolId(), type: 'SETUP_CHANGE',
        // The proposer's own campus, so their Ops Admin can follow it; the owner sees every campus anyway.
        campusId: user.campusId ?? null,
        title: label.slice(0, 200),
        payload: JSON.parse(JSON.stringify({ action: key, data: payload ?? null })),
        requestedById: user.userId,
      },
    });
    await this.audit.record({
      action: AuditActions.APPROVAL_REQUESTED, entityType: 'ApprovalRequest', entityId: created.id,
      newValue: { type: 'SETUP_CHANGE', action: key, title: label },
    });
    res?.setHeader(PENDING_APPROVAL_HEADER, created.id);
    return { pendingApproval: true, approvalId: created.id, message: 'Sent to the owner for approval. It takes effect once approved.' };
  }
}

@Global()
@Module({ providers: [ProposalsService], exports: [ProposalsService] })
export class ProposalsModule {}
