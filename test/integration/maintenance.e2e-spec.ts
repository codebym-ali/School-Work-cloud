import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import { CommonModule } from '@common';
import { DatabaseModule, PlatformPrismaService } from '@database';
import { FeeJobsService } from '../../apps/api/src/modules/fees/fee-jobs.service';
import { MaintenanceService } from '../../apps/worker/src/maintenance/maintenance.service';

/**
 * Cross-tenant nightly maintenance runner (blueprint §27). Verifies the runner iterates
 * EVERY active tenant (each in its own CLS + withTenant context) and runs the fee jobs
 * without error — the per-tenant fee logic itself is covered by the fees e2e. Suspended
 * tenants are skipped.
 */
describe('Maintenance runner (e2e, §27)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let maintenance: MaintenanceService;

  const schoolA = randomUUID();
  const schoolB = randomUUID();
  const suspended = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true }), CommonModule, DatabaseModule],
      providers: [MaintenanceService, FeeJobsService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    platform = app.get(PlatformPrismaService);
    maintenance = app.get(MaintenanceService);

    await platform.school.create({ data: { id: schoolA, name: 'Maint A', subdomain: `mnt-${schoolA.slice(0, 8)}` } });
    await platform.school.create({ data: { id: schoolB, name: 'Maint B', subdomain: `mnt-${schoolB.slice(0, 8)}` } });
    // A suspended tenant must be skipped by the runner.
    await platform.school.create({ data: { id: suspended, name: 'Maint S', subdomain: `mnt-${suspended.slice(0, 8)}`, isActive: false } });
  });

  afterAll(async () => {
    await platform.school.deleteMany({ where: { id: { in: [schoolA, schoolB, suspended] } } });
    await app.close();
  });

  it('runs mark-overdue across every ACTIVE tenant (suspended skipped)', async () => {
    const activeCount = await platform.school.count({ where: { isActive: true } });
    const res = await maintenance.run('mark-overdue');
    expect(res.schools).toBe(activeCount);
    // Our two active schools are counted; the suspended one is not (activeCount excludes it).
    expect(res.schools).toBeGreaterThanOrEqual(2);
  });

  it('runs fee-integrity-check across every active tenant without error', async () => {
    const res = await maintenance.run('fee-integrity-check');
    expect(res.schools).toBeGreaterThanOrEqual(2);
  });
});
