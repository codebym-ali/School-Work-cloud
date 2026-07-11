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
    const ids = { in: [schoolA, schoolB, suspended] };
    await platform.idempotencyKey.deleteMany({ where: { schoolId: ids } });
    await platform.smsLog.deleteMany({ where: { schoolId: ids } });
    await platform.school.deleteMany({ where: { id: ids } });
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

  it('idempotency-purge deletes keys older than 48h, keeps recent ones', async () => {
    const old = randomUUID();
    const recent = randomUUID();
    await platform.idempotencyKey.create({
      data: { id: old, schoolId: schoolA, key: `old-${old}`, requestHash: 'h', createdAt: new Date(Date.now() - 72 * 3600 * 1000) },
    });
    await platform.idempotencyKey.create({
      data: { id: recent, schoolId: schoolA, key: `new-${recent}`, requestHash: 'h', createdAt: new Date() },
    });

    const res = await maintenance.run('idempotency-purge');
    expect(res.deleted).toBeGreaterThanOrEqual(1);
    expect(await platform.idempotencyKey.findUnique({ where: { id: old } })).toBeNull();
    expect(await platform.idempotencyKey.findUnique({ where: { id: recent } })).not.toBeNull();

    await platform.idempotencyKey.deleteMany({ where: { id: { in: [old, recent] } } });
  });

  it('sms-log-purge deletes logs older than the retention window, keeps recent ones', async () => {
    const oldLog = randomUUID();
    const recentLog = randomUUID();
    const base = { schoolId: schoolA, recipient: '+923001112222', message: 'x', templateKey: 'MANUAL', segments: 1, status: 'SENT' as const };
    await platform.smsLog.create({ data: { id: oldLog, ...base, createdAt: new Date(Date.now() - 200 * 24 * 3600 * 1000) } });
    await platform.smsLog.create({ data: { id: recentLog, ...base, createdAt: new Date() } });

    const res = await maintenance.run('sms-log-purge');
    expect(res.deleted).toBeGreaterThanOrEqual(1);
    expect(await platform.smsLog.findUnique({ where: { id: oldLog } })).toBeNull();
    expect(await platform.smsLog.findUnique({ where: { id: recentLog } })).not.toBeNull();

    await platform.smsLog.deleteMany({ where: { id: { in: [oldLog, recentLog] } } });
  });
});
