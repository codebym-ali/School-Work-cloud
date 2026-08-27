import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../apps/api/src/app.module';
import { PlatformPrismaService } from '@database';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { destroyTenant } from './support/tenant';

/**
 * Vendor billing — SA6 (decision D3: in-house, per-student). The VENDOR charges each school a monthly
 * rate per ACTIVE student (the SAME student definition as the fleet dashboard, Law 4), invoices it,
 * and records offline payments. Every amount is FROZEN at issue. Billing is confined to the
 * billing-capable roles (SUPER_ADMIN + BILLING); the ledger row survives an SA7 tenant purge.
 */
describe('Platform vendor billing (e2e, §24 SA6)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;

  const HOST = 'admin.localhost';
  const password = 'Operator!Secret12';
  const superEmail = `bill-super-${randomUUID().slice(0, 8)}@platform.pk`;
  const billingEmail = `bill-billing-${randomUUID().slice(0, 8)}@platform.pk`;
  const analystEmail = `bill-analyst-${randomUUID().slice(0, 8)}@platform.pk`;
  let superId: string;
  let billingId: string;
  let analystId: string;

  // A: priced, with 3 active students (the billing lifecycle + purge-survival). B: unpriced (refusals).
  let schoolA: string;
  let schoolB: string;
  const subA = `bill-a-${randomUUID().slice(0, 8)}`;
  const subB = `bill-b-${randomUUID().slice(0, 8)}`;
  const PRICE = 250; // PKR/student/month → 3 students = 750.00
  const STUDENTS = 3;

  const server = () => app.getHttpServer();
  const cookiesOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[]) ?? [];
  const cookieHeader = (cs: string[]) => cs.map((c) => c.split(';')[0]).join('; ');
  const csrfOf = (cs: string[]) => (cs.find((c) => c.startsWith('platform_csrf=')) ?? '').split(';')[0].split('=')[1];
  const login = (email: string) => request(server()).post('/api/v1/platform/auth/login').set('Host', HOST).send({ email, password });

  let superCookies: string[];
  let billingCookies: string[];
  let analystCookies: string[];

  const post = (cookies: string[], path: string, body?: unknown) =>
    request(server()).post(`/api/v1/platform/${path}`).set('Host', HOST).set('Cookie', cookieHeader(cookies)).set('X-CSRF-Token', csrfOf(cookies)).send(body ?? {});
  const put = (cookies: string[], path: string, body?: unknown) =>
    request(server()).put(`/api/v1/platform/${path}`).set('Host', HOST).set('Cookie', cookieHeader(cookies)).set('X-CSRF-Token', csrfOf(cookies)).send(body ?? {});
  const get = (cookies: string[], path: string) =>
    request(server()).get(`/api/v1/platform/${path}`).set('Host', HOST).set('Cookie', cookieHeader(cookies));

  async function seedActiveStudents(schoolId: string, campusId: string, n: number) {
    const ay = await platform.academicYear.create({ data: { schoolId, name: '2026-27', startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31'), isCurrent: true } });
    const klass = await platform.class.create({ data: { schoolId, campusId, name: 'Grade 1', order: 1 } });
    const section = await platform.section.create({ data: { schoolId, classId: klass.id, name: 'A' } });
    for (let i = 0; i < n; i++) {
      const student = await platform.student.create({ data: { schoolId, grNumber: `GR-${randomUUID().slice(0, 8)}`, fullName: `Student ${i}`, gender: 'MALE', dateOfBirth: new Date('2018-01-01') } });
      await platform.studentEnrollment.create({ data: { schoolId, studentId: student.id, academicYearId: ay.id, campusId, classId: klass.id, sectionId: section.id, status: 'ACTIVE' } });
    }
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const provisioning = app.get(ProvisioningService, { strict: false });
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    superId = (await platform.platformUser.create({ data: { email: superEmail, name: 'Bill Super', role: 'SUPER_ADMIN', status: 'ACTIVE', passwordHash } })).id;
    billingId = (await platform.platformUser.create({ data: { email: billingEmail, name: 'Bill Billing', role: 'BILLING', status: 'ACTIVE', passwordHash } })).id;
    analystId = (await platform.platformUser.create({ data: { email: analystEmail, name: 'Bill Analyst', role: 'ANALYST', status: 'ACTIVE', passwordHash } })).id;

    schoolA = (await provisioning.provisionSchool({ name: 'Billing A', subdomain: subA, ownerEmail: `owner-${subA}@example.com`, ownerPassword: 'OwnerA!Secret12' })).schoolId;
    schoolB = (await provisioning.provisionSchool({ name: 'Billing B', subdomain: subB, ownerEmail: `owner-${subB}@example.com`, ownerPassword: 'OwnerB!Secret12' })).schoolId;
    const campusA = await platform.campus.findFirst({ where: { schoolId: schoolA }, select: { id: true } });
    await seedActiveStudents(schoolA, campusA!.id, STUDENTS);

    superCookies = cookiesOf(await login(superEmail));
    billingCookies = cookiesOf(await login(billingEmail));
    analystCookies = cookiesOf(await login(analystEmail));
  });

  afterAll(async () => {
    const ids = [superId, billingId, analystId].filter(Boolean) as string[];
    for (const uid of ids) {
      await platform.platformAuditLog.deleteMany({ where: { platformUserId: uid } });
      await platform.platformRefreshToken.deleteMany({ where: { platformUserId: uid } });
    }
    // Invoices for A survive its purge (tenantId → null); clean them by the subdomain snapshot.
    await platform.platformInvoice.deleteMany({ where: { tenantSubdomain: { in: [subA, subB] } } });
    for (const sid of [schoolA, schoolB]) await destroyTenant(platform, sid); // A may already be purged → no-op
    await platform.platformUser.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  it('refuses to invoice a school with no price set (422)', async () => {
    const res = await post(superCookies, 'billing/invoices', { tenantId: schoolB, year: 2026, month: 1 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('sets a per-student price (SUPER_ADMIN) and audits it from→to', async () => {
    const res = await put(superCookies, `billing/tenants/${schoolA}/price`, { pricePerStudent: PRICE });
    expect(res.status).toBe(200);
    expect(res.body.pricePerStudent).toBe('250.00');
    const db = await platform.school.findUnique({ where: { id: schoolA }, select: { pricePerStudent: true } });
    expect(Number(db?.pricePerStudent)).toBe(PRICE);
    const audit = await platform.platformAuditLog.findMany({ where: { action: 'TENANT_PRICE_SET', targetTenantId: schoolA } });
    expect(audit).toHaveLength(1);
    expect((audit[0].metadata as { to: string }).to).toBe('250.00');
  });

  it('a BILLING operator can also set a price; an ANALYST cannot (403)', async () => {
    expect((await put(billingCookies, `billing/tenants/${schoolB}/price`, { pricePerStudent: 100 })).status).toBe(200);
    const denied = await put(analystCookies, `billing/tenants/${schoolB}/price`, { pricePerStudent: 999 });
    expect(denied.status).toBe(403);
    // The analyst's attempt changed nothing.
    expect(Number((await platform.school.findUnique({ where: { id: schoolB }, select: { pricePerStudent: true } }))?.pricePerStudent)).toBe(100);
  });

  it('generates an invoice: amount = active students × price, frozen (201)', async () => {
    const res = await post(superCookies, 'billing/invoices', { tenantId: schoolA, year: 2026, month: 1 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      tenantSubdomain: subA, periodYear: 2026, periodMonth: 1,
      studentCount: STUDENTS, pricePerStudent: '250.00', amount: '750.00', status: 'ISSUED',
    });
    const audit = await platform.platformAuditLog.findMany({ where: { action: 'INVOICE_GENERATED', targetTenantId: schoolA } });
    expect(audit).toHaveLength(1);
  });

  it('refuses a duplicate invoice for the same school-month (409)', async () => {
    const res = await post(superCookies, 'billing/invoices', { tenantId: schoolA, year: 2026, month: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('the billing overview reflects MRR and outstanding', async () => {
    const res = await get(superCookies, 'billing/overview');
    expect(res.status).toBe(200);
    // schoolA (priced 250 × 3 active) contributes 750 to MRR; other unpriced tenants contribute 0.
    expect(Number(res.body.mrr)).toBeGreaterThanOrEqual(750);
    expect(res.body.pricedSchools).toBeGreaterThanOrEqual(1);
    // The one issued, unpaid invoice is outstanding.
    expect(Number(res.body.outstanding)).toBeGreaterThanOrEqual(750);
  });

  it('records an offline payment: ISSUED → PAID (audited), and refuses a second payment (422)', async () => {
    const inv = await platform.platformInvoice.findFirstOrThrow({ where: { tenantId: schoolA, periodMonth: 1 } });
    const paid = await post(superCookies, `billing/invoices/${inv.id}/pay`, { method: 'BANK_TRANSFER', reference: 'TRX-123' });
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ status: 'PAID', paymentMethod: 'BANK_TRANSFER', paymentReference: 'TRX-123' });
    expect(paid.body.paidAt).toBeTruthy();
    const audit = await platform.platformAuditLog.findMany({ where: { action: 'INVOICE_PAID', targetTenantId: schoolA } });
    expect(audit).toHaveLength(1);
    // A paid invoice can't be paid again.
    expect((await post(superCookies, `billing/invoices/${inv.id}/pay`, { method: 'CASH' })).status).toBe(422);
  });

  it('voids an issued invoice with a reason; a PAID invoice cannot be voided (422)', async () => {
    // A fresh period so there is an ISSUED invoice to void.
    const gen = await post(billingCookies, 'billing/invoices', { tenantId: schoolA, year: 2026, month: 2 });
    expect(gen.status).toBe(201);
    const voided = await post(superCookies, `billing/invoices/${gen.body.id}/void`, { reason: 'duplicate charge' });
    expect(voided.status).toBe(200);
    expect(voided.body).toMatchObject({ status: 'VOID', note: 'duplicate charge' });
    // The January invoice is PAID → voiding it is refused.
    const paid = await platform.platformInvoice.findFirstOrThrow({ where: { tenantId: schoolA, periodMonth: 1 } });
    expect((await post(superCookies, `billing/invoices/${paid.id}/void`, { reason: 'nope' })).status).toBe(422);
  });

  it('forbids an ANALYST from listing invoices or reading the overview (403)', async () => {
    expect((await get(analystCookies, 'billing/invoices')).status).toBe(403);
    expect((await get(analystCookies, 'billing/overview')).status).toBe(403);
    expect((await post(analystCookies, 'billing/invoices', { tenantId: schoolA, year: 2026, month: 3 })).status).toBe(403);
  });

  it('billing history SURVIVES an SA7 tenant purge (tenant_id → null, snapshot kept)', async () => {
    // Terminate + backdate the retention window, then purge schoolA (SA7).
    await post(superCookies, `tenants/${schoolA}/terminate`, { reason: 'offboard for billing test' });
    await platform.school.update({ where: { id: schoolA }, data: { purgeAfter: new Date(Date.now() - 1000) } });
    expect((await post(superCookies, `tenants/${schoolA}/purge`, { confirmSubdomain: subA })).status).toBe(200);

    // The school is gone, but its invoices remain — tenant_id nulled, the subdomain snapshot preserved.
    expect(await platform.school.count({ where: { id: schoolA } })).toBe(0);
    const survivors = await platform.platformInvoice.findMany({ where: { tenantSubdomain: subA } });
    expect(survivors.length).toBeGreaterThanOrEqual(2); // Jan (paid) + Feb (void)
    expect(survivors.every((i) => i.tenantId === null)).toBe(true);
  });
});
