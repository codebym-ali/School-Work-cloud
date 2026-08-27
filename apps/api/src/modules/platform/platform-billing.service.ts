import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppError, ErrorCodes, paginate, toSkipTake, type Paginated } from '@common';
import { PlatformPrismaService } from '@database';
import { PlatformAuditService } from './platform-audit.service';
import type { PlatformActionContext } from './platform.service';
import type { ListInvoicesQuery } from './dto/platform.dto';

/** Days from issue to due date on a vendor invoice (SA6). */
const INVOICE_DUE_DAYS = 14;

/** SA6b dunning: days PAST the due date an invoice may stay unpaid before the school is auto-suspended.
 *  With the 14-day due window, a school is suspended ~21 days after an invoice is issued. */
const DUNNING_GRACE_DAYS = 7;

/** A write actor for an audit row: an operator id, or `null` for a SYSTEM action (SA6b automated jobs). */
type ActionActor = { platformUserId: string | null; ip?: string };

/** How the console renders one vendor invoice. Money is serialised as a decimal string (never a float),
 *  and `isOverdue` is DERIVED (past due while still ISSUED), never stored (Law 4). */
export interface InvoiceSummary {
  id: string;
  tenantId: string | null;
  tenantSubdomain: string;
  periodYear: number;
  periodMonth: number;
  studentCount: number;
  pricePerStudent: string;
  amount: string;
  currency: string;
  status: 'ISSUED' | 'PAID' | 'VOID';
  isOverdue: boolean;
  issuedAt: Date;
  dueAt: Date;
  paidAt: Date | null;
  paymentMethod: string | null;
  paymentReference: string | null;
  note: string | null;
}

/** The billing dashboard totals (SA6). Every figure is ONE server-side definition (Law 4). */
export interface BillingOverview {
  currency: string;
  /** Monthly recurring revenue: Σ (price_per_student × ACTIVE students) over active, priced schools. */
  mrr: string;
  /** Σ amount of ISSUED (unpaid) invoices. */
  outstanding: string;
  /** Σ amount of ISSUED invoices whose due date has passed. */
  overdue: string;
  /** Σ amount PAID with a payment date in the current calendar month. */
  collectedThisMonth: string;
  /** Σ amount ever PAID. */
  collectedAllTime: string;
  pricedSchools: number;
  unpricedActiveSchools: number;
  issuedCount: number;
  overdueCount: number;
}

/** Vendor-wide billing settings (SA6c). */
export interface BillingSettings {
  /** When on, a NON-PAYMENT-suspended school is auto-reactivated once it clears its overdue balance. */
  autoReactivateOnPayment: boolean;
}

/**
 * Vendor billing (SA6, decision D3 — in-house, per-student). The VENDOR charges each school a monthly
 * rate per ACTIVE student (the SAME student definition as the fleet dashboard, Law 4). Runs on the
 * platform_admin (BYPASSRLS) connection; `platform_invoices` is a NON-tenant table. Every write is
 * audited. Money is `Prisma.Decimal` end-to-end (never a float) and FROZEN onto the invoice at issue,
 * so re-pricing or enrolment changes never rewrite history.
 */
@Injectable()
export class PlatformBillingService {
  constructor(
    private readonly platform: PlatformPrismaService,
    private readonly audit: PlatformAuditService,
  ) {}

  private toSummary(inv: {
    id: string; tenantId: string | null; tenantSubdomain: string; periodYear: number; periodMonth: number;
    studentCount: number; pricePerStudent: Prisma.Decimal; amount: Prisma.Decimal; currency: string;
    status: 'ISSUED' | 'PAID' | 'VOID'; issuedAt: Date; dueAt: Date; paidAt: Date | null;
    paymentMethod: string | null; paymentReference: string | null; note: string | null;
  }): InvoiceSummary {
    return {
      id: inv.id,
      tenantId: inv.tenantId,
      tenantSubdomain: inv.tenantSubdomain,
      periodYear: inv.periodYear,
      periodMonth: inv.periodMonth,
      studentCount: inv.studentCount,
      pricePerStudent: inv.pricePerStudent.toFixed(2),
      amount: inv.amount.toFixed(2),
      currency: inv.currency,
      status: inv.status,
      isOverdue: inv.status === 'ISSUED' && inv.dueAt < new Date(),
      issuedAt: inv.issuedAt,
      dueAt: inv.dueAt,
      paidAt: inv.paidAt,
      paymentMethod: inv.paymentMethod,
      paymentReference: inv.paymentReference,
      note: inv.note,
    };
  }

  /** Set the vendor's monthly per-student price for a school (SA6). Audited `TENANT_PRICE_SET` (from→to). */
  async setPricePerStudent(tenantId: string, price: number, ctx: PlatformActionContext): Promise<{ id: string; pricePerStudent: string }> {
    const school = await this.platform.school.findUnique({ where: { id: tenantId }, select: { id: true, pricePerStudent: true } });
    if (!school) throw new AppError(ErrorCodes.TENANT_NOT_FOUND, HttpStatus.NOT_FOUND, 'Tenant not found');

    const next = new Prisma.Decimal(price);
    await this.platform.school.update({ where: { id: tenantId }, data: { pricePerStudent: next } });
    await this.audit.record({
      platformUserId: ctx.platformUserId,
      action: 'TENANT_PRICE_SET',
      targetTenantId: tenantId,
      metadata: { from: school.pricePerStudent?.toFixed(2) ?? null, to: next.toFixed(2) },
      ip: ctx.ip,
    });
    return { id: tenantId, pricePerStudent: next.toFixed(2) };
  }

  /**
   * Generate a vendor invoice for one school for one month (SA6). Refused unless the school has a price
   * set, and one-per-(school, month) is enforced by find-then-write (not upsert — the tenant-model rule,
   * and this is a platform table anyway). `student_count`, `price_per_student` and `amount` are FROZEN.
   */
  async generateInvoice(tenantId: string, year: number, month: number, ctx: PlatformActionContext): Promise<InvoiceSummary> {
    const school = await this.platform.school.findUnique({ where: { id: tenantId }, select: { id: true, subdomain: true, pricePerStudent: true } });
    if (!school) throw new AppError(ErrorCodes.TENANT_NOT_FOUND, HttpStatus.NOT_FOUND, 'Tenant not found');
    if (school.pricePerStudent == null) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Set a per-student price for this school before invoicing');
    }
    const existing = await this.platform.platformInvoice.findFirst({ where: { tenantId, periodYear: year, periodMonth: month }, select: { id: true } });
    if (existing) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, `An invoice already exists for ${school.subdomain} ${year}-${String(month).padStart(2, '0')}`);
    }
    const studentCount = await this.activeStudentCount(tenantId);
    return this.insertInvoice({ id: school.id, subdomain: school.subdomain, pricePerStudent: school.pricePerStudent }, year, month, studentCount, ctx, 'operator');
  }

  /** ACTIVE enrollments for a school — the SAME definition as the fleet dashboard (Law 4). */
  private activeStudentCount(schoolId: string): Promise<number> {
    return this.platform.studentEnrollment.count({ where: { schoolId, status: 'ACTIVE' } });
  }

  /**
   * Create ONE invoice for a school+period and audit it (`INVOICE_GENERATED`). The single place where
   * `amount = students × price` is frozen — shared by the manual route and the SA6b auto-invoice job
   * (`source` distinguishes them, and the actor is null for the automated run). The caller guarantees
   * the school is priced and no invoice exists for the period yet.
   */
  private async insertInvoice(
    school: { id: string; subdomain: string; pricePerStudent: Prisma.Decimal },
    year: number, month: number, studentCount: number, ctx: ActionActor, source: 'operator' | 'auto',
  ): Promise<InvoiceSummary> {
    const price = school.pricePerStudent;
    const amount = price.mul(studentCount);
    const issuedAt = new Date();
    const dueAt = new Date(issuedAt.getTime() + INVOICE_DUE_DAYS * 24 * 60 * 60 * 1000);
    const inv = await this.platform.platformInvoice.create({
      data: {
        tenantId: school.id,
        tenantSubdomain: school.subdomain,
        periodYear: year,
        periodMonth: month,
        studentCount,
        pricePerStudent: price,
        amount,
        issuedAt,
        dueAt,
      },
    });
    await this.audit.record({
      platformUserId: ctx.platformUserId,
      action: 'INVOICE_GENERATED',
      targetTenantId: school.id,
      metadata: { invoiceId: inv.id, period: `${year}-${String(month).padStart(2, '0')}`, studentCount, amount: amount.toFixed(2), source },
      ip: ctx.ip,
    });
    return this.toSummary(inv);
  }

  /** List vendor invoices (SA6), newest first, filterable by tenant and status. */
  async listInvoices(q: ListInvoicesQuery): Promise<Paginated<InvoiceSummary>> {
    const where: Prisma.PlatformInvoiceWhereInput = {
      ...(q.tenantId ? { tenantId: q.tenantId } : {}),
      ...(q.status ? { status: q.status as 'ISSUED' | 'PAID' | 'VOID' } : {}),
    };
    const { skip, take } = toSkipTake(q);
    const [rows, total] = await Promise.all([
      this.platform.platformInvoice.findMany({ where, orderBy: [{ issuedAt: 'desc' }], skip, take }),
      this.platform.platformInvoice.count({ where }),
    ]);
    return paginate(rows.map((r) => this.toSummary(r)), total, q);
  }

  /** Record an OFFLINE payment (SA6) — an ISSUED invoice becomes PAID. Audited `INVOICE_PAID`. */
  async recordPayment(invoiceId: string, input: { method: string; reference?: string; paidAt?: string }, ctx: PlatformActionContext): Promise<InvoiceSummary> {
    const inv = await this.platform.platformInvoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Invoice not found');
    if (inv.status !== 'ISSUED') {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, `Only an issued invoice can be paid (this one is ${inv.status})`);
    }
    const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();
    const updated = await this.platform.platformInvoice.update({
      where: { id: invoiceId },
      data: { status: 'PAID', paidAt, paymentMethod: input.method, paymentReference: input.reference ?? null },
    });
    await this.audit.record({
      platformUserId: ctx.platformUserId,
      action: 'INVOICE_PAID',
      targetTenantId: inv.tenantId ?? undefined,
      metadata: { invoiceId, method: input.method, reference: input.reference ?? null, amount: inv.amount.toFixed(2) },
      ip: ctx.ip,
    });
    // SA6c: if enabled, bring a NON-PAYMENT-suspended school back online once this payment clears its
    // overdue balance. Runs after the payment is committed; never fails the payment if it can't reactivate.
    await this.maybeAutoReactivate(inv.tenantId, ctx);
    return this.toSummary(updated);
  }

  /**
   * SA6c auto-reactivate: after a payment, un-suspend the school IF (and only if) the vendor opted in
   * (`autoReactivateOnPayment`), the school is currently suspended **for non-payment** (never a manual /
   * legal hold), it isn't scheduled for termination, and it has **no overdue invoice left** past the
   * dunning grace window. Attributed to the operator who recorded the payment. Takes effect within the
   * API host-cache TTL (same as the dunning suspend), so no cross-process cache invalidation is needed.
   */
  private async maybeAutoReactivate(tenantId: string | null, ctx: ActionActor): Promise<void> {
    if (!tenantId) return;
    const settings = await this.getOrCreateSettings();
    if (!settings.autoReactivateOnPayment) return;

    const school = await this.platform.school.findUnique({ where: { id: tenantId }, select: { isActive: true, suspendedReason: true, purgeAfter: true } });
    if (!school || school.isActive || school.suspendedReason !== 'NON_PAYMENT' || school.purgeAfter) return;

    // Still carrying an invoice past the grace window? Then it isn't clear yet — leave it suspended.
    const cutoff = new Date(Date.now() - DUNNING_GRACE_DAYS * 24 * 60 * 60 * 1000);
    const stillOverdue = await this.platform.platformInvoice.count({ where: { tenantId, status: 'ISSUED', dueAt: { lt: cutoff } } });
    if (stillOverdue > 0) return;

    await this.platform.school.update({ where: { id: tenantId }, data: { isActive: true, suspendedAt: null, suspendedReason: null } });
    await this.audit.record({
      platformUserId: ctx.platformUserId,
      action: 'TENANT_AUTO_REACTIVATE',
      targetTenantId: tenantId,
      metadata: { source: 'auto-on-payment' },
      ip: ctx.ip,
    });
  }

  /** Void an ISSUED invoice (SA6). A PAID invoice cannot be voided (record a refund out of band). Audited. */
  async voidInvoice(invoiceId: string, reason: string, ctx: PlatformActionContext): Promise<InvoiceSummary> {
    const inv = await this.platform.platformInvoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Invoice not found');
    if (inv.status !== 'ISSUED') {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, `Only an issued invoice can be voided (this one is ${inv.status})`);
    }
    const updated = await this.platform.platformInvoice.update({ where: { id: invoiceId }, data: { status: 'VOID', note: reason } });
    await this.audit.record({
      platformUserId: ctx.platformUserId,
      action: 'INVOICE_VOID',
      targetTenantId: inv.tenantId ?? undefined,
      reason,
      metadata: { invoiceId, amount: inv.amount.toFixed(2) },
      ip: ctx.ip,
    });
    return this.toSummary(updated);
  }

  /** The billing dashboard (SA6). A handful of aggregates — MRR from the live priced fleet, and the
   *  outstanding / overdue / collected sums from the invoice ledger. */
  async getBillingOverview(): Promise<BillingOverview> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // MRR = Σ (price × ACTIVE students) over the active, priced schools.
    const pricedSchools = await this.platform.school.findMany({
      where: { isActive: true, pricePerStudent: { not: null } },
      select: { id: true, pricePerStudent: true },
    });
    const unpricedActiveSchools = await this.platform.school.count({ where: { isActive: true, pricePerStudent: null } });

    let mrr = new Prisma.Decimal(0);
    if (pricedSchools.length > 0) {
      const counts = await this.platform.studentEnrollment.groupBy({
        by: ['schoolId'],
        where: { status: 'ACTIVE', schoolId: { in: pricedSchools.map((s) => s.id) } },
        _count: { _all: true },
      });
      const countBySchool = new Map(counts.map((c) => [c.schoolId, c._count._all]));
      for (const s of pricedSchools) {
        mrr = mrr.add((s.pricePerStudent as Prisma.Decimal).mul(countBySchool.get(s.id) ?? 0));
      }
    }

    const [outstanding, overdue, collectedThisMonth, collectedAllTime, issuedCount, overdueCount] = await Promise.all([
      this.platform.platformInvoice.aggregate({ where: { status: 'ISSUED' }, _sum: { amount: true } }),
      this.platform.platformInvoice.aggregate({ where: { status: 'ISSUED', dueAt: { lt: now } }, _sum: { amount: true } }),
      this.platform.platformInvoice.aggregate({ where: { status: 'PAID', paidAt: { gte: startOfMonth } }, _sum: { amount: true } }),
      this.platform.platformInvoice.aggregate({ where: { status: 'PAID' }, _sum: { amount: true } }),
      this.platform.platformInvoice.count({ where: { status: 'ISSUED' } }),
      this.platform.platformInvoice.count({ where: { status: 'ISSUED', dueAt: { lt: now } } }),
    ]);

    const sum = (agg: { _sum: { amount: Prisma.Decimal | null } }) => (agg._sum.amount ?? new Prisma.Decimal(0)).toFixed(2);
    return {
      currency: 'PKR',
      mrr: mrr.toFixed(2),
      outstanding: sum(outstanding),
      overdue: sum(overdue),
      collectedThisMonth: sum(collectedThisMonth),
      collectedAllTime: sum(collectedAllTime),
      pricedSchools: pricedSchools.length,
      unpricedActiveSchools,
      issuedCount,
      overdueCount,
    };
  }

  // ── SA6c vendor billing settings (the auto-reactivate switch) ──────────────────────────────────

  /** The single vendor-settings row, created with defaults on first read (find-then-write, not upsert). */
  private async getOrCreateSettings(): Promise<BillingSettings> {
    const row = await this.platform.platformSettings.findFirst({ select: { autoReactivateOnPayment: true } });
    if (row) return row;
    const created = await this.platform.platformSettings.create({ data: {}, select: { autoReactivateOnPayment: true } });
    return created;
  }

  /** Read the vendor billing settings (SA6c). */
  getBillingSettings(): Promise<BillingSettings> {
    return this.getOrCreateSettings();
  }

  /** Toggle auto-reactivate-on-payment (SA6c, SUPER_ADMIN/BILLING). Audited `BILLING_SETTINGS_UPDATE`. */
  async setAutoReactivate(enabled: boolean, ctx: PlatformActionContext): Promise<BillingSettings> {
    const existing = await this.platform.platformSettings.findFirst({ select: { id: true } });
    if (existing) {
      await this.platform.platformSettings.update({ where: { id: existing.id }, data: { autoReactivateOnPayment: enabled, updatedById: ctx.platformUserId } });
    } else {
      await this.platform.platformSettings.create({ data: { autoReactivateOnPayment: enabled, updatedById: ctx.platformUserId } });
    }
    await this.audit.record({
      platformUserId: ctx.platformUserId,
      action: 'BILLING_SETTINGS_UPDATE',
      metadata: { autoReactivateOnPayment: enabled },
      ip: ctx.ip,
    });
    return { autoReactivateOnPayment: enabled };
  }

  // ── SA6b automation (system jobs — no operator; the audit actor is null) ───────────────────────

  /**
   * Auto-invoice (SA6b) — generate the CURRENT month's invoice for every ACTIVE, priced school that has
   * at least one active student and isn't already invoiced for the period. Idempotent (the per-(school,
   * month) check + the unique index), so re-running fires nothing new; a suspended or unpriced school is
   * skipped, and a 0-student school gets no zero-amount noise. Returns the number of invoices created.
   */
  async runMonthlyBilling(now: Date = new Date()): Promise<number> {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const schools = await this.platform.school.findMany({
      where: { isActive: true, pricePerStudent: { not: null } },
      select: { id: true, subdomain: true, pricePerStudent: true },
    });
    let created = 0;
    for (const school of schools) {
      const exists = await this.platform.platformInvoice.findFirst({ where: { tenantId: school.id, periodYear: year, periodMonth: month }, select: { id: true } });
      if (exists) continue;
      const studentCount = await this.activeStudentCount(school.id);
      if (studentCount === 0) continue; // don't manufacture a zero-amount invoice
      await this.insertInvoice(
        { id: school.id, subdomain: school.subdomain, pricePerStudent: school.pricePerStudent as Prisma.Decimal },
        year, month, studentCount, { platformUserId: null }, 'auto',
      );
      created++;
    }
    return created;
  }

  /**
   * Dunning (SA6b) — auto-suspend any ACTIVE school with an ISSUED invoice unpaid more than
   * DUNNING_GRACE_DAYS past its due date. This is the one place billing touches the tenant: it flips
   * `isActive` off (the API host-cache picks it up within its TTL) and audits `TENANT_AUTO_SUSPEND`
   * (null actor). A purged tenant (tenant_id null) has no live school, so it can't be suspended, and an
   * already-suspended school is excluded by the `tenant.isActive` filter (no re-suspend spam).
   * Reactivation after payment stays a manual operator step (deliberate — see the plan). Returns the
   * number of schools suspended.
   */
  async runDunning(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - DUNNING_GRACE_DAYS * 24 * 60 * 60 * 1000);
    const overdue = await this.platform.platformInvoice.findMany({
      where: { status: 'ISSUED', dueAt: { lt: cutoff }, tenant: { isActive: true } },
      select: { id: true, tenantId: true, periodYear: true, periodMonth: true, dueAt: true, amount: true },
      orderBy: { dueAt: 'asc' },
    });
    const seen = new Set<string>();
    let suspended = 0;
    for (const inv of overdue) {
      const sid = inv.tenantId;
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);
      // Stamp the reason NON_PAYMENT (SA6c) so auto-reactivate-on-payment may later un-suspend it — a
      // manual/legal-hold suspend carries 'MANUAL' and is never touched by auto-reactivate.
      await this.platform.school.update({ where: { id: sid }, data: { isActive: false, suspendedAt: now, suspendedReason: 'NON_PAYMENT' } });
      await this.audit.record({
        platformUserId: null,
        action: 'TENANT_AUTO_SUSPEND',
        targetTenantId: sid,
        reason: `Auto-suspended: invoice ${inv.periodYear}-${String(inv.periodMonth).padStart(2, '0')} unpaid > ${DUNNING_GRACE_DAYS} days past due`,
        metadata: { source: 'auto', invoiceId: inv.id, dueAt: inv.dueAt.toISOString(), amount: inv.amount.toFixed(2) },
      });
      suspended++;
    }
    return suspended;
  }
}
