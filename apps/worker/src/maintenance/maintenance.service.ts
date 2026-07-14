import { Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { captureError, CLS_KEYS } from '@common';
import { PlatformPrismaService, TenantPrismaService } from '@database';
import { FeeJobsService } from '../../../api/src/modules/fees/fee-jobs.service';
import { PLAN_MONTHLY_SMS_CREDITS } from '../../../api/src/modules/comms/sms/sms-plan-credits';

export type MaintenanceJob =
  | 'mark-overdue'
  | 'fee-integrity-check'
  | 'idempotency-purge'
  | 'sms-log-purge'
  | 'sms-monthly-credit';

export interface MaintenanceResult {
  /** Tenants processed (per-tenant fee jobs). */
  schools?: number;
  /** Rows deleted (global purge jobs). */
  deleted?: number;
  /** Tenants granted this month's SMS plan credit. */
  credited?: number;
}

/** Idempotency keys expire after 48h (blueprint §25.4). */
const IDEMPOTENCY_TTL_MS = 48 * 60 * 60 * 1000;
/** SMS logs retained ~180 days (billing/audit) then purged (§27). */
const SMS_LOG_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Cross-tenant nightly maintenance (blueprint §27). Fee jobs run per active tenant
 * (each in its own CLS + RLS-bound `withTenant` tx, like a request); global purges run
 * once across all tenants on the platform_admin (BYPASSRLS) connection. A failure in one
 * tenant is logged + Sentry-reported and doesn't abort the rest.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    private readonly cls: ClsService,
    private readonly platform: PlatformPrismaService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly feeJobs: FeeJobsService,
  ) {}

  async run(job: MaintenanceJob): Promise<MaintenanceResult> {
    switch (job) {
      case 'mark-overdue':
      case 'fee-integrity-check':
        return { schools: await this.runFeeJobPerTenant(job) };
      case 'idempotency-purge':
        return { deleted: await this.purgeIdempotencyKeys() };
      case 'sms-log-purge':
        return { deleted: await this.purgeSmsLogs() };
      case 'sms-monthly-credit':
        return { credited: await this.grantMonthlySmsCredits() };
    }
  }

  /** Run a fee job for every ACTIVE tenant, isolated per school. */
  private async runFeeJobPerTenant(job: 'mark-overdue' | 'fee-integrity-check'): Promise<number> {
    const schools = await this.platform.school.findMany({ where: { isActive: true }, select: { id: true } });
    for (const school of schools) {
      await this.cls.run(async () => {
        this.cls.set(CLS_KEYS.schoolId, school.id);
        try {
          await this.tenantPrisma.withTenant(async () => {
            if (job === 'mark-overdue') {
              await this.feeJobs.markOverdue();
            } else {
              const result = await this.feeJobs.checkIntegrity();
              if (!result.ok) {
                // §27: a fee-integrity mismatch pages on-call. Surface it loudly.
                this.logger.warn(`fee-integrity mismatch in school ${school.id}: ${result.mismatches.length} invoice(s)`);
                captureError(new Error('fee-integrity mismatch'), { schoolId: school.id });
              }
            }
          });
        } catch (err) {
          this.logger.error(`maintenance "${job}" failed for school ${school.id}: ${(err as Error).message}`);
          captureError(err, { schoolId: school.id });
        }
      });
    }
    return schools.length;
  }

  /** Global purge (all tenants, one query) via the BYPASSRLS connection. */
  private async purgeIdempotencyKeys(): Promise<number> {
    const cutoff = new Date(Date.now() - IDEMPOTENCY_TTL_MS);
    const { count } = await this.platform.idempotencyKey.deleteMany({ where: { createdAt: { lt: cutoff } } });
    this.logger.log(`idempotency-purge: deleted ${count} key(s) older than 48h`);
    return count;
  }

  private async purgeSmsLogs(): Promise<number> {
    const cutoff = new Date(Date.now() - SMS_LOG_RETENTION_MS);
    const { count } = await this.platform.smsLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    this.logger.log(`sms-log-purge: deleted ${count} log(s) older than 180d`);
    return count;
  }

  /**
   * Refresh each ACTIVE tenant's monthly SMS plan credit (§14). Runs on the 1st; a
   * cross-tenant billing grant, so it uses the platform (BYPASSRLS) connection (§21.5).
   * Idempotent per calendar month: skip any tenant that already has a PLAN_MONTHLY grant
   * this month (the provisioning grant counts, so a tenant onboarded mid-month isn't
   * double-credited). Safe to re-run — BullMQ fires it once fleet-wide anyway.
   */
  private async grantMonthlySmsCredits(): Promise<number> {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    const schools = await this.platform.school.findMany({
      where: { isActive: true },
      select: { id: true, planTier: true },
    });
    let credited = 0;
    for (const school of schools) {
      const alreadyGranted = await this.platform.smsCreditLedger.findFirst({
        where: { schoolId: school.id, refType: 'PLAN_MONTHLY', createdAt: { gte: monthStart, lt: nextMonth } },
        select: { id: true },
      });
      if (alreadyGranted) continue;
      await this.platform.smsCreditLedger.create({
        data: { schoolId: school.id, delta: PLAN_MONTHLY_SMS_CREDITS[school.planTier], refType: 'PLAN_MONTHLY' },
      });
      credited++;
    }
    this.logger.log(`sms-monthly-credit: granted this month's SMS plan credit to ${credited} tenant(s)`);
    return credited;
  }
}
