import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { SMS_QUEUE } from '../../apps/api/src/modules/comms/sms/sms.types';
import { admissionController } from './support/admission';
import { destroyTenant } from './support/tenant';
import { loginRequest } from './support/login';
import { enrolMfa } from './support/mfa';

/**
 * Idempotency & concurrency (QA plan C4). Existing tests cover SEQUENTIAL idempotency replay + batch dedup;
 * this covers true PARALLEL races — the class behind Bug #1 (a receipt-number collision that 500'd two
 * simultaneous cashiers). Each case fires N requests with `Promise.all` and asserts exactly-one-effect:
 *   • same Idempotency-Key sent concurrently → ONE payment persists (not N).
 *   • N concurrent DISTINCT-key payments → all 201, receipt numbers all UNIQUE (no collision → no 500),
 *     and paidAmount == the exact sum.
 *   • concurrent double-reverse of one payment → exactly one 201, the rest 409 (never two reversals / 500).
 */
describe('Idempotency & concurrency — parallel money races (e2e, §12/§25.3)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let csrf: string;
  let classId: string;
  let studentId: string;
  const host = `idem-${randomUUID().slice(0, 6)}.localhost`;
  const email = 'owner@idem.pk';
  const password = 'Owner!Secret12';

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, body: object = {}, headers: Record<string, string> = {}) => {
    let r = request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(body);
  };
  const get = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);
  const idem = () => ({ 'Idempotency-Key': randomUUID() });

  /** Fresh invoice each test so the cases don't interfere. */
  async function freshInvoice(month: number): Promise<{ id: string; total: number }> {
    await post('/api/v1/fees/invoice-batches', { classId, month, year: 2026 });
    const inv = (await get(`/api/v1/fees/invoices?studentId=${studentId}&month=${month}&year=2026`)).body.data[0];
    return { id: inv.id, total: Number(inv.totalAmount) };
  }
  const invoice = (id: string) => get(`/api/v1/fees/invoices/${id}`);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    platform = app.get(PlatformPrismaService);

    const prov = await app.get(ProvisioningService, { strict: false }).provisionSchool({ name: 'Idem School', subdomain: host.split('.')[0], ownerEmail: email, ownerPassword: password });
    schoolId = prov.schoolId;
    cookies = await enrolMfa(server(), host, (await loginRequest(server(), host, email, password)).headers['set-cookie'] as unknown as string[]);
    csrf = csrfOf(cookies);

    const yearId = (await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true })).body.id;
    classId = (await post('/api/v1/classes', { campusId: prov.campusId, name: 'Grade 1', order: 1 })).body.id;
    const sectionId = (await post('/api/v1/sections', { classId, name: 'A' })).body.id;
    const { admit } = await admissionController(app, platform, schoolId, host, prov.campusId);
    studentId = (await admit({
      fullName: 'Race Child', gender: 'MALE', dateOfBirth: '2020-05-10', campusId: prov.campusId, classId, sectionId,
      guardian: { mode: 'CREATE', fullName: 'Race Guardian', phone: '03007654321', relation: 'FATHER' },
    })).body.studentId;
    const head = await post('/api/v1/fee-heads', { name: 'Tuition' });
    await post('/api/v1/fee-structures', { campusId: prov.campusId, classId, feeHeadId: head.body.id, academicYearId: yearId, amount: 1000, frequency: 'MONTHLY' });
  }, 120_000);

  afterAll(async () => {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    if (schoolId) await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('the SAME idempotency key sent concurrently records exactly one payment', async () => {
    const inv = await freshInvoice(10);
    const key = randomUUID();
    const body = { amountPaid: 200, method: 'CASH' };
    const results = await Promise.all(Array.from({ length: 5 }, () => post(`/api/v1/fees/invoices/${inv.id}/payments`, body, { 'Idempotency-Key': key })));

    // Every response resolves cleanly (no 500) — the idempotency layer collapses the duplicates.
    for (const r of results) expect(r.status).toBeLessThan(500);
    // The effect is single: exactly one payment's worth of money on the invoice.
    const after = await invoice(inv.id);
    expect(Number(after.body.paidAmount)).toBeCloseTo(200, 2);
  }, 60_000);

  it('N concurrent distinct-key payments get unique receipt numbers (no collision → no 500)', async () => {
    const inv = await freshInvoice(11);
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () => post(`/api/v1/fees/invoices/${inv.id}/payments`, { amountPaid: 1, method: 'CASH' }, idem())),
    );
    expect(results.every((r) => r.status === 201)).toBe(true); // the receipt-counter race that used to 500
    const receipts = results.map((r) => r.body.receiptNo);
    expect(new Set(receipts).size).toBe(N); // no two payments drew the same receipt number
    const after = await invoice(inv.id);
    expect(Number(after.body.paidAmount)).toBeCloseTo(N, 2); // all N applied, none lost or double-counted
  }, 60_000);

  it('concurrent double-reverse of one payment → exactly one 201, the rest 409', async () => {
    const inv = await freshInvoice(12);
    const pay = await post(`/api/v1/fees/invoices/${inv.id}/payments`, { amountPaid: 500, method: 'CASH' }, idem());
    expect(pay.status).toBe(201);
    const paymentId = pay.body.paymentId;

    const results = await Promise.all(
      Array.from({ length: 4 }, () => post(`/api/v1/fees/payments/${paymentId}/reversals`, { reason: 'double click' }, idem())),
    );
    const ok = results.filter((r) => r.status === 201);
    const conflict = results.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1); // exactly one reversal wins
    expect(conflict).toHaveLength(3); // the rest are cleanly refused, never a 500 and never a second reversal
    for (const r of results) expect(r.status).toBeLessThan(500);

    // The money unwound exactly once: back to zero, not negative, not still-paid.
    const after = await invoice(inv.id);
    expect(Number(after.body.paidAmount)).toBeCloseTo(0, 2);
    expect(after.body.status).not.toBe('PAID');
  }, 60_000);
});
