import { Injectable } from '@nestjs/common';
import { FeeInvoiceStatus } from '@prisma/client';
import { TenantContext } from '@common';
import { TenantPrismaService } from '@database';

const money = (n: number): number => Math.round(n * 100) / 100;

export interface IntegrityMismatch {
  invoiceId: string;
  field: 'totalAmount' | 'paidAmount';
  stored: number;
  computed: number;
}

/**
 * Fee background jobs (blueprint §12, §27), written as tenant-scoped service methods
 * the worker runs per school (and tests call directly):
 *  - `markOverdue` — nightly: OVERDUE past dueDate+grace, upsert a single FINE line.
 *  - `checkIntegrity` — nightly: verify totalAmount = Σ items and paidAmount = Σ payments − Σ reversals.
 */
@Injectable()
export class FeeJobsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }
  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  async markOverdue(): Promise<{ marked: number; fined: number }> {
    const now = new Date();
    const policy = await this.db.lateFeePolicy.findFirst({ where: { schoolId: this.sid, isActive: true } });
    const grace = policy?.graceDays ?? 0;
    const cutoff = new Date(now.getTime() - grace * 86400000);
    const invoices = await this.db.feeInvoice.findMany({
      where: { status: { in: [FeeInvoiceStatus.PENDING, FeeInvoiceStatus.PARTIAL] }, dueDate: { lt: cutoff } },
      include: { items: true },
    });

    let marked = 0;
    let fined = 0;
    for (const inv of invoices) {
      if (policy) {
        const daysOverdue = Math.max(Math.floor((now.getTime() - new Date(inv.dueDate).getTime()) / 86400000) - grace, 1);
        let fine = policy.mode === 'PER_DAY' ? Number(policy.amount) * daysOverdue : Number(policy.amount);
        if (policy.maxAmount != null) fine = Math.min(fine, Number(policy.maxAmount));
        fine = money(fine);

        const existingFine = inv.items.find((i) => i.type === 'FINE');
        if (existingFine) {
          if (money(Number(existingFine.amount)) !== fine) {
            await this.db.feeInvoiceItem.update({ where: { id: existingFine.id }, data: { amount: fine } });
          }
        } else {
          await this.db.feeInvoiceItem.create({ data: { schoolId: this.sid, invoiceId: inv.id, type: 'FINE', description: 'Late fee', amount: fine } });
        }
        const items = await this.db.feeInvoiceItem.findMany({ where: { invoiceId: inv.id } });
        const total = money(items.reduce((s, i) => s + Number(i.amount), 0));
        await this.db.feeInvoice.update({ where: { id: inv.id }, data: { totalAmount: total, status: FeeInvoiceStatus.OVERDUE } });
        fined++;
      } else {
        await this.db.feeInvoice.update({ where: { id: inv.id }, data: { status: FeeInvoiceStatus.OVERDUE } });
      }
      marked++;
    }
    return { marked, fined };
  }

  async checkIntegrity(): Promise<{ ok: boolean; mismatches: IntegrityMismatch[] }> {
    const invoices = await this.db.feeInvoice.findMany({ include: { items: true, payments: true } });
    const reversals = await this.db.paymentReversal.findMany({});
    const reversedIds = new Set(reversals.map((r) => r.paymentId));

    const mismatches: IntegrityMismatch[] = [];
    for (const inv of invoices) {
      const itemsTotal = money(inv.items.reduce((s, i) => s + Number(i.amount), 0));
      const paid = money(inv.payments.filter((p) => !reversedIds.has(p.id)).reduce((s, p) => s + Number(p.amountPaid), 0));
      if (money(Number(inv.totalAmount)) !== itemsTotal) {
        mismatches.push({ invoiceId: inv.id, field: 'totalAmount', stored: money(Number(inv.totalAmount)), computed: itemsTotal });
      }
      if (money(Number(inv.paidAmount)) !== paid) {
        mismatches.push({ invoiceId: inv.id, field: 'paidAmount', stored: money(Number(inv.paidAmount)), computed: paid });
      }
    }
    return { ok: mismatches.length === 0, mismatches };
  }
}
