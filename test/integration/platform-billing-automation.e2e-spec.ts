import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../apps/api/src/app.module';
import { PlatformPrismaService } from '@database';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { PlatformBillingService } from '../../apps/api/src/modules/platform/platform-billing.service';
import { destroyTenant } from './support/tenant';

/**
 * Vendor billing AUTOMATION — SA6b. Two SYSTEM jobs (no operator, null audit actor):
 *   • auto-invoice — generate the month's invoice for every priced, active school with students;
 *   • dunning — auto-suspend a school whose invoice is unpaid past the grace window.
 * Both are exercised by calling the service directly (they run on the worker, off a BullMQ repeatable).
 */
describe('Platform vendor billing automation (e2e, §24 SA6b)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let billing: PlatformBillingService;

  const sub = (p: string) => `auto-${p}-${randomUUID().slice(0, 8)}`;
  const subA = sub('a'); // priced + students → gets an auto-invoice
  const subB = sub('b'); // unpriced → skipped
  const subC = sub('c'); // priced + ZERO students → skipped (no zero-amount invoice)
  const subD = sub('d'); // overdue ISSUED invoice → dunning suspends
  const subE = sub('e'); // overdue but PAID invoice → dunning leaves alone
  const subF = sub('f'); // ISSUED but within grace → dunning leaves alone
  let A = '', B = '', C = '', D = '', E = '', F = '';

  // Auto-invoice bills the CURRENT month; use a far-future month so it can't collide with real data.
  const RUN = new Date(Date.UTC(2029, 5, 15)); // June 2029
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  async function seedActiveStudents(schoolId: string, n: number) {
    const campus = await platform.campus.findFirstOrThrow({ where: { schoolId }, select: { id: true } });
    const ay = await platform.academicYear.create({ data: { schoolId, name: '2029-30', startDate: new Date('2029-04-01'), endDate: new Date('2030-03-31'), isCurrent: true } });
    const klass = await platform.class.create({ data: { schoolId, campusId: campus.id, name: 'Grade 1', order: 1 } });
    const section = await platform.section.create({ data: { schoolId, classId: klass.id, name: 'A' } });
    for (let i = 0; i < n; i++) {
      const student = await platform.student.create({ data: { schoolId, grNumber: `GR-${randomUUID().slice(0, 8)}`, fullName: `S${i}`, gender: 'MALE', dateOfBirth: new Date('2018-01-01') } });
      await platform.studentEnrollment.create({ data: { schoolId, studentId: student.id, academicYearId: ay.id, campusId: campus.id, classId: klass.id, sectionId: section.id, status: 'ACTIVE' } });
    }
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    billing = app.get(PlatformBillingService);
    const provisioning = app.get(ProvisioningService, { strict: false });
    const mk = async (s: string) => (await provisioning.provisionSchool({ name: s, subdomain: s, ownerEmail: `owner-${s}@example.com`, ownerPassword: 'Owner!Secret12' })).schoolId;
    [A, B, C, D, E, F] = await Promise.all([mk(subA), mk(subB), mk(subC), mk(subD), mk(subE), mk(subF)]);

    // A: priced with 2 active students. C: priced with 0 students. B/D/E/F: left unpriced (dunning
    // reads invoices, not price, and leaving them unpriced keeps them out of the auto-invoice run).
    await platform.school.update({ where: { id: A }, data: { pricePerStudent: 250 } });
    await platform.school.update({ where: { id: C }, data: { pricePerStudent: 100 } });
    await seedActiveStudents(A, 2);
  });

  afterAll(async () => {
    const ids = [A, B, C, D, E, F].filter(Boolean);
    await platform.platformAuditLog.deleteMany({ where: { targetTenantId: { in: ids } } });
    await platform.platformInvoice.deleteMany({ where: { tenantSubdomain: { in: [subA, subB, subC, subD, subE, subF] } } });
    for (const id of ids) await destroyTenant(platform, id);
    await app.close();
  });

  it('auto-invoice generates the month\'s invoice for priced schools with students only', async () => {
    const created = await billing.runMonthlyBilling(RUN);
    expect(created).toBeGreaterThanOrEqual(1);

    // A (priced 250 × 2 students) got a June-2029 invoice, amount frozen at 500.00.
    const invA = await platform.platformInvoice.findFirst({ where: { tenantId: A, periodYear: 2029, periodMonth: 6 } });
    expect(invA).toBeTruthy();
    expect(invA!.studentCount).toBe(2);
    expect(invA!.amount.toFixed(2)).toBe('500.00');
    expect(invA!.status).toBe('ISSUED');

    // B (unpriced) and C (priced but zero students) got nothing.
    expect(await platform.platformInvoice.count({ where: { tenantId: B, periodYear: 2029, periodMonth: 6 } })).toBe(0);
    expect(await platform.platformInvoice.count({ where: { tenantId: C, periodYear: 2029, periodMonth: 6 } })).toBe(0);

    // The automated invoice is audited with a null (system) actor and source 'auto'.
    const audit = await platform.platformAuditLog.findFirst({ where: { action: 'INVOICE_GENERATED', targetTenantId: A } });
    expect(audit!.platformUserId).toBeNull();
    expect((audit!.metadata as { source: string }).source).toBe('auto');
  });

  it('auto-invoice is idempotent per month (a re-run creates nothing new)', async () => {
    const again = await billing.runMonthlyBilling(RUN);
    expect(again).toBe(0);
    expect(await platform.platformInvoice.count({ where: { tenantId: A, periodYear: 2029, periodMonth: 6 } })).toBe(1);
  });

  it('dunning auto-suspends a school unpaid past grace, but not paid or within-grace ones', async () => {
    // D: ISSUED invoice 30 days past due (> 7-day grace) → should suspend.
    await platform.platformInvoice.create({ data: { tenantId: D, tenantSubdomain: subD, periodYear: 2029, periodMonth: 1, studentCount: 1, pricePerStudent: 300, amount: 300, status: 'ISSUED', issuedAt: daysAgo(44), dueAt: daysAgo(30) } });
    // E: same age but already PAID → dunning ignores it.
    await platform.platformInvoice.create({ data: { tenantId: E, tenantSubdomain: subE, periodYear: 2029, periodMonth: 1, studentCount: 1, pricePerStudent: 300, amount: 300, status: 'PAID', issuedAt: daysAgo(44), dueAt: daysAgo(30), paidAt: daysAgo(20), paymentMethod: 'BANK_TRANSFER' } });
    // F: ISSUED but only 2 days past due (within the 7-day grace) → not yet.
    await platform.platformInvoice.create({ data: { tenantId: F, tenantSubdomain: subF, periodYear: 2029, periodMonth: 1, studentCount: 1, pricePerStudent: 300, amount: 300, status: 'ISSUED', issuedAt: daysAgo(16), dueAt: daysAgo(2) } });

    const suspended = await billing.runDunning();
    expect(suspended).toBe(1);

    expect((await platform.school.findUnique({ where: { id: D }, select: { isActive: true } }))!.isActive).toBe(false);
    expect((await platform.school.findUnique({ where: { id: E }, select: { isActive: true } }))!.isActive).toBe(true);
    expect((await platform.school.findUnique({ where: { id: F }, select: { isActive: true } }))!.isActive).toBe(true);
    // A's fresh auto-invoice is due in the future, so A is never a dunning target.
    expect((await platform.school.findUnique({ where: { id: A }, select: { isActive: true } }))!.isActive).toBe(true);

    const audit = await platform.platformAuditLog.findFirst({ where: { action: 'TENANT_AUTO_SUSPEND', targetTenantId: D } });
    expect(audit).toBeTruthy();
    expect(audit!.platformUserId).toBeNull();
    expect((audit!.metadata as { source: string }).source).toBe('auto');
  });

  it('dunning does not re-suspend an already-suspended school', async () => {
    const suspended = await billing.runDunning();
    expect(suspended).toBe(0); // D is already suspended → excluded by the active-tenant filter
    expect(await platform.platformAuditLog.count({ where: { action: 'TENANT_AUTO_SUSPEND', targetTenantId: D } })).toBe(1);
  });
});
