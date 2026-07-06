import { Injectable } from '@nestjs/common';
import { TenantContext } from '@common';
import { TenantPrismaService } from '@database';

/**
 * SMS credit ledger (blueprint §14). Balance is the sum of ledger deltas
 * (+top-ups, −send debits). Balance ≤ 0 blocks non-critical sends, but critical
 * transactional sends (ABSENCE, FEE_RECEIPT) may go into a small negative overdraft
 * buffer (Setting.smsOverdraftSegments) so credit lag never blocks safety messages.
 */
@Injectable()
export class CreditsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  async balance(): Promise<number> {
    const agg = await this.db.smsCreditLedger.aggregate({ _sum: { delta: true } });
    return agg._sum.delta ?? 0;
  }

  async topUp(segments: number, refType: 'PLAN_MONTHLY' | 'PURCHASE', refId?: string): Promise<void> {
    await this.db.smsCreditLedger.create({
      data: { schoolId: this.ctx.requireSchoolId(), delta: segments, refType, refId },
    });
  }

  async debit(segments: number, smsLogId: string): Promise<void> {
    await this.db.smsCreditLedger.create({
      data: { schoolId: this.ctx.requireSchoolId(), delta: -segments, refType: 'SEND', refId: smsLogId },
    });
  }
}
