import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppError, AuditActions, ErrorCodes, restrictedCampusId, TenantContext } from '@common';
import { AuditService, TenantPrismaService } from '@database';
import { PaymentsService } from '../fees/payments.service';
import { ProposalsService } from './proposals.service';

export interface ApprovalListQuery { status?: 'PENDING' | 'APPROVED' | 'REJECTED'; type?: 'VOUCHER_BATCH' | 'SETUP_CHANGE' }

interface VoucherPayload { month: number; year: number; result?: { issued: number; total: number } | { voided: number; total: number } }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const money = (n: number): number => Math.round(n * 100) / 100;

/**
 * Approval requests — the owner signs off what the office prepared (Campus Ops Admin plan).
 *
 * VOUCHER_BATCH: the campus's monthly vouchers sit as PENDING_APPROVAL invoices. Approving issues them (status →
 * PENDING, and the guardian's advance is applied NOW, at issue, not at generation); rejecting voids them
 * — they were never issued, so nothing was owed, paid or sent — and frees the classes to be billed again.
 *
 * The request is only a description; the invoices are the truth, so what the owner is shown is counted live from
 * them rather than from a stored figure that could drift.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly audit: AuditService,
    private readonly payments: PaymentsService,
    private readonly proposals: ProposalsService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  /** A campus-bound person (Ops Admin) sees only their own campus's requests; the owner sees every campus. */
  private scope(): Prisma.ApprovalRequestWhereInput {
    const restricted = restrictedCampusId(this.ctx.user);
    return restricted !== null ? { campusId: restricted } : {};
  }

  async list(q: ApprovalListQuery) {
    const rows = await this.db.approvalRequest.findMany({
      where: { ...this.scope(), ...(q.status ? { status: q.status } : {}), ...(q.type ? { type: q.type } : {}) },
      // Waiting requests first, then the newest decisions.
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 100,
      include: {
        campus: { select: { name: true } },
        requestedBy: { select: { email: true, fullName: true } },
        decidedBy: { select: { email: true, fullName: true } },
      },
    });
    return Promise.all(rows.map((r) => this.present(r)));
  }

  async pendingCount(): Promise<number> {
    return this.db.approvalRequest.count({ where: { status: 'PENDING', ...this.scope() } });
  }

  async get(id: string) {
    const row = await this.db.approvalRequest.findFirst({
      where: { id, ...this.scope() },
      include: {
        campus: { select: { name: true } },
        requestedBy: { select: { email: true, fullName: true } },
        decidedBy: { select: { email: true, fullName: true } },
      },
    });
    if (!row) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Approval request not found');
    return this.present(row);
  }

  /** Approve → the held vouchers are issued. Owner only (enforced by the route). */
  async approve(id: string, note?: string) {
    const req = await this.requirePending(id);
    let result: Record<string, unknown> = {};
    if (req.type === 'VOUCHER_BATCH') result = await this.issueVouchers(req);
    else if (req.type === 'SETUP_CHANGE') result = await this.applySetupChange(req);
    else throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, `Cannot approve a ${req.type} request`);

    await this.db.approvalRequest.update({
      where: { id },
      data: {
        status: 'APPROVED', decidedById: this.ctx.user!.userId, decidedAt: new Date(), decisionNote: note?.slice(0, 300) ?? null,
        payload: { ...(req.payload as object), result } as Prisma.InputJsonValue,
      },
    });
    await this.audit.record({
      action: AuditActions.APPROVAL_APPROVED, entityType: 'ApprovalRequest', entityId: id,
      oldValue: { status: 'PENDING' }, newValue: { status: 'APPROVED', ...result },
    });
    return this.get(id);
  }

  /** Reject → the held vouchers are voided; the classes can be billed again. A reason is required. */
  async reject(id: string, reason: string) {
    const req = await this.requirePending(id);
    let result: Record<string, unknown> = {};
    if (req.type === 'VOUCHER_BATCH') result = await this.voidVouchers(req);
    else if (req.type === 'SETUP_CHANGE') result = { applied: false }; // nothing was ever changed — a proposal has no side effects
    else throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, `Cannot reject a ${req.type} request`);

    await this.db.approvalRequest.update({
      where: { id },
      data: {
        status: 'REJECTED', decidedById: this.ctx.user!.userId, decidedAt: new Date(), decisionNote: reason.slice(0, 300),
        payload: { ...(req.payload as object), result } as Prisma.InputJsonValue,
      },
    });
    await this.audit.record({
      action: AuditActions.APPROVAL_REJECTED, entityType: 'ApprovalRequest', entityId: id,
      oldValue: { status: 'PENDING' }, newValue: { status: 'REJECTED', reason, ...result },
    });
    return this.get(id);
  }

  // ── Setup changes ─────────────────────────────────────────────────────────────────────────────────────────
  /**
   * Run the proposed change with the stored payload — through the very executor the direct call uses, as the owner.
   * If it is no longer valid (e.g. a fee row already billed from, a term now referenced) the service's own error
   * reaches the owner, and the request stays PENDING so they can reject it with a reason.
   */
  private async applySetupChange(req: { payload: unknown }) {
    const p = req.payload as { action: string; data: unknown };
    if (!this.proposals.isKnown(p.action)) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'This change is no longer supported — please reject it');
    }
    await this.proposals.execute(p.action, p.data);
    return { applied: true };
  }

  // ── Voucher batches ───────────────────────────────────────────────────────────────────────────────────────
  private voucherWhere(req: { campusId: string | null; payload: unknown }): Prisma.FeeInvoiceWhereInput {
    const p = req.payload as VoucherPayload;
    return { status: 'PENDING_APPROVAL', month: p.month, year: p.year, enrollment: { campusId: req.campusId ?? undefined } };
  }

  private async issueVouchers(req: { campusId: string | null; payload: unknown }) {
    const held = await this.db.feeInvoice.findMany({ where: this.voucherWhere(req), select: { id: true, totalAmount: true } });
    await this.db.feeInvoice.updateMany({ where: { id: { in: held.map((i) => i.id) }, status: 'PENDING_APPROVAL' }, data: { status: 'PENDING' } });
    // The voucher is issued NOW, so a family's standing advance is applied now — not when it was only a draft.
    for (const inv of held) await this.payments.applyAdvanceToInvoice(inv.id);
    return { issued: held.length, total: money(held.reduce((s, i) => s + Number(i.totalAmount), 0)) };
  }

  private async voidVouchers(req: { campusId: string | null; payload: unknown }) {
    const p = req.payload as VoucherPayload;
    const held = await this.db.feeInvoice.findMany({ where: this.voucherWhere(req), select: { id: true, totalAmount: true, batchId: true } });
    // Items cascade. Safe: a held voucher was never issued — no payment, claim, SMS or family view can reference it.
    await this.db.feeInvoice.deleteMany({ where: { id: { in: held.map((i) => i.id) }, status: 'PENDING_APPROVAL' } });
    // Free the classes to be billed again: drop the class batches left with no invoices (createBatch refuses a class
    // that already has a batch for the month).
    const batchIds = [...new Set(held.map((i) => i.batchId).filter((b): b is string => b !== null))];
    for (const batchId of batchIds) {
      if ((await this.db.feeInvoice.count({ where: { batchId } })) === 0) await this.db.feeInvoiceBatch.deleteMany({ where: { id: batchId } });
    }
    void p;
    return { voided: held.length, total: money(held.reduce((s, i) => s + Number(i.totalAmount), 0)) };
  }

  // ── Presentation ──────────────────────────────────────────────────────────────────────────────────────────
  private async requirePending(id: string) {
    const req = await this.db.approvalRequest.findFirst({ where: { id, ...this.scope() } });
    if (!req) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Approval request not found');
    if (req.status !== 'PENDING') {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, `This request was already ${req.status.toLowerCase()}`);
    }
    return req;
  }

  private async present(r: {
    id: string; type: string; status: string; campusId: string | null; title: string; payload: unknown; createdAt: Date;
    decidedAt: Date | null; decisionNote: string | null;
    campus: { name: string } | null;
    requestedBy: { email: string; fullName: string | null };
    decidedBy: { email: string; fullName: string | null } | null;
  }) {
    const who = (u: { email: string; fullName: string | null } | null) => (u ? u.fullName ?? u.email : null);
    let summary: { vouchers: number; total: number; classes: string[]; period: string } | null = null;
    if (r.type === 'VOUCHER_BATCH') {
      const p = r.payload as VoucherPayload;
      const period = `${MONTHS[(p.month ?? 1) - 1]} ${p.year}`;
      if (r.status === 'PENDING') {
        // Counted live from the held invoices — the request itself stores no figure that could go stale.
        const held = await this.db.feeInvoice.findMany({
          where: this.voucherWhere(r),
          select: { totalAmount: true, enrollment: { select: { class: { select: { name: true } } } } },
        });
        summary = {
          vouchers: held.length, total: money(held.reduce((s, i) => s + Number(i.totalAmount), 0)), period,
          classes: [...new Set(held.map((i) => i.enrollment.class.name))].sort(),
        };
      } else {
        const res = (p.result ?? {}) as { issued?: number; voided?: number; total?: number };
        summary = { vouchers: res.issued ?? res.voided ?? 0, total: res.total ?? 0, period, classes: [] };
      }
    }
    // What a setup change WOULD do, in the proposer's own values — the owner approves a change, not a code name.
    // Top-level primitives only, long lists summarised; ids are hidden (they mean nothing to a person).
    let changes: Array<{ label: string; value: string }> | null = null;
    if (r.type === 'SETUP_CHANGE') {
      const data = ((r.payload as { data?: unknown })?.data ?? {}) as Record<string, unknown>;
      const flat = (o: Record<string, unknown>): Array<{ label: string; value: string }> => Object.entries(o)
        .filter(([k, v]) => v !== null && v !== undefined && !/(^id$|Id$)/.test(k))
        .map(([k, v]) => ({
          label: k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()),
          value: Array.isArray(v) ? `${v.length} item${v.length === 1 ? '' : 's'}` : typeof v === 'object' ? 'details' : String(v),
        }));
      changes = flat(data).slice(0, 12);
      if (data && typeof data === 'object' && 'dto' in data && typeof data.dto === 'object' && data.dto) changes = flat(data.dto as Record<string, unknown>).slice(0, 12);
    }
    return {
      changes,
      id: r.id, type: r.type, status: r.status, title: r.title,
      campusId: r.campusId, campusName: r.campus?.name ?? null,
      requestedBy: who(r.requestedBy), requestedAt: r.createdAt,
      decidedBy: who(r.decidedBy), decidedAt: r.decidedAt, decisionNote: r.decisionNote,
      summary,
    };
  }
}
