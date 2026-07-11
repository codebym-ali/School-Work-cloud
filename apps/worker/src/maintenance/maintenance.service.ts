import { Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { captureError, CLS_KEYS } from '@common';
import { PlatformPrismaService, TenantPrismaService } from '@database';
import { FeeJobsService } from '../../../api/src/modules/fees/fee-jobs.service';

export type MaintenanceJob = 'mark-overdue' | 'fee-integrity-check';

/**
 * Cross-tenant nightly maintenance (blueprint §27). The fee-job LOGIC lives in the
 * request-path `FeeJobsService` (tested via the fees e2e); this runs it for EVERY active
 * tenant, each inside its own CLS context + RLS-bound `withTenant` tx — exactly like a
 * request, so RLS and the tenant extension apply. A failure in one tenant is logged +
 * reported and does not abort the others.
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

  async run(job: MaintenanceJob): Promise<{ schools: number }> {
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
    return { schools: schools.length };
  }
}
