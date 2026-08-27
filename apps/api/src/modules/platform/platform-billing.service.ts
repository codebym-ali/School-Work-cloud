import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppError, ErrorCodes, paginate, toSkipTake, type Paginated } from '@common';
import { PlatformPrismaService } from '@database';
import { PlatformAuditService } from './platform-audit.service';
import type { PlatformActionContext } from './platform.service';
import type { ListInvoicesQuery } from './dto/platform.dto';

/** Days from issue to due date on a vendor invoice (SA6). */
const INVOICE_DUE_DAYS = 14;

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

    // ACTIVE enrollments — the SAME definition as the fleet dashboard (Law 4), not raw `students`.
    const studentCount = await this.platform.studentEnrollment.count({ where: { schoolId: tenantId, status: 'ACTIVE' } });
    const price = school.pricePerStudent;
    const amount = price.mul(studentCount);
    const issuedAt = new Date();
    const dueAt = new Date(issuedAt.getTime() + INVOICE_DUE_DAYS * 24 * 60 * 60 * 1000);

    const inv = await this.platform.platformInvoice.create({
      data: {
        tenantId,
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
      targetTenantId: tenantId,
      metadata: { invoiceId: inv.id, period: `${year}-${String(month).padStart(2, '0')}`, studentCount, amount: amount.toFixed(2) },
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
    return this.toSummary(updated);
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
}
