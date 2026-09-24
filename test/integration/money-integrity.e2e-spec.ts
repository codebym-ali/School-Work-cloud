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
 * Money & ledger integrity (QA plan C5). Money bugs hide on the happy path, so this runs a randomized but
 * SEEDED (reproducible) sequence of pay / overpay / reverse operations across a student's invoices and, after
 * every step, asserts the ledger invariants directly against the API's own view:
 *   • paidAmount == Σ(amountPaid of that invoice's NON-reversed payments)   — the ledger reconciles
 *   • 0 ≤ paidAmount ≤ totalAmount                                          — never negative, never over
 *   • status = PAID iff paidAmount ≥ total; PARTIAL iff 0 < paid < total    — status tracks the money
 *   • an overpayment is refused (422) and moves nothing                     — the advance path, not silent
 *   • a reversed payment's invoice is never left PAID by that payment        — reversal actually unwinds
 * The oracle is tracked independently in the test, so a service that miscomputes paidAmount fails here.
 */
const SEED = 0x9e3779b9;
function rng() {
  let s = SEED >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const pick = <T>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)];
const randInt = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

interface Inv { id: string; total: number }
interface Pay { paymentId: string; invId: string; amount: number; reversed: boolean }

describe('Money & ledger integrity — randomized pay/reverse sequence (e2e, §12)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let csrf: string;
  const host = `mny-${randomUUID().slice(0, 6)}.localhost`;
  const email = 'owner@mny.pk';
  const password = 'Owner!Secret12';
  const TOTAL = 1000;

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, body: object = {}, headers: Record<string, string> = {}) => {
    let r = request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(body);
  };
  const get = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);
  const idem = () => ({ 'Idempotency-Key': randomUUID() });

  const invoices: Inv[] = [];
  const payments: Pay[] = [];
  const netPaid = (invId: string) =>
    payments.filter((p) => p.invId === invId && !p.reversed).reduce((s, p) => s + p.amount, 0);

  /** Read the invoice back from the API and assert every invariant against the tracked oracle. */
  async function assertInvariants(invId: string) {
    const res = await get(`/api/v1/fees/invoices/${invId}`);
    expect(res.status).toBe(200);
    const paid = Number(res.body.paidAmount);
    const total = Number(res.body.totalAmount);
    const expected = netPaid(invId);
    expect(paid).toBeCloseTo(expected, 2);        // ledger reconciles
    expect(paid).toBeGreaterThanOrEqual(0);        // never negative
    expect(paid).toBeLessThanOrEqual(total + 1e-9); // never over the total
    if (paid <= 1e-9) expect(res.body.status).not.toBe('PAID');
    else if (paid >= total - 1e-9) expect(res.body.status).toBe('PAID');
    else expect(res.body.status).toBe('PARTIAL');
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    platform = app.get(PlatformPrismaService);

    const prov = await app.get(ProvisioningService, { strict: false }).provisionSchool({ name: 'Money School', subdomain: host.split('.')[0], ownerEmail: email, ownerPassword: password });
    schoolId = prov.schoolId;
    cookies = await enrolMfa(server(), host, (await loginRequest(server(), host, email, password)).headers['set-cookie'] as unknown as string[]);
    csrf = csrfOf(cookies);

    const yearId = (await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true })).body.id;
    const classId = (await post('/api/v1/classes', { campusId: prov.campusId, name: 'Grade 1', order: 1 })).body.id;
    const sectionId = (await post('/api/v1/sections', { classId, name: 'A' })).body.id;
    const { admit } = await admissionController(app, platform, schoolId, host, prov.campusId);
    const student = await admit({
      fullName: 'Ledger Child', gender: 'MALE', dateOfBirth: '2020-05-10', campusId: prov.campusId, classId, sectionId,
      guardian: { mode: 'CREATE', fullName: 'Ledger Guardian', phone: '03007654321', relation: 'FATHER' },
    });
    const studentId = student.body.studentId;

    const head = await post('/api/v1/fee-heads', { name: 'Tuition' });
    await post('/api/v1/fee-structures', { campusId: prov.campusId, classId, feeHeadId: head.body.id, academicYearId: yearId, amount: TOTAL, frequency: 'MONTHLY' });
    // Future months so nothing flips to OVERDUE mid-run (today is well before Oct 2026 due dates).
    for (const month of [10, 11, 12]) {
      await post('/api/v1/fees/invoice-batches', { classId, month, year: 2026 });
      const inv = (await get(`/api/v1/fees/invoices?studentId=${studentId}&month=${month}&year=2026`)).body.data[0];
      invoices.push({ id: inv.id, total: Number(inv.totalAmount) });
    }
  }, 120_000);

  afterAll(async () => {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    if (schoolId) await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('seeded three invoices, each starting unpaid', async () => {
    expect(invoices).toHaveLength(3);
    for (const inv of invoices) {
      expect(inv.total).toBe(TOTAL);
      await assertInvariants(inv.id);
    }
  });

  it('holds every ledger invariant across a randomized pay/overpay/reverse sequence', async () => {
    const r = rng();
    for (let step = 0; step < 40; step++) {
      const op = r();
      if (op < 0.6) {
        // PAY a random amount within the remaining balance.
        const payable = invoices.filter((i) => TOTAL - netPaid(i.id) > 0);
        if (!payable.length) continue;
        const inv = pick(r, payable);
        const remaining = TOTAL - netPaid(inv.id);
        const amount = randInt(r, 1, remaining);
        const res = await post(`/api/v1/fees/invoices/${inv.id}/payments`, { amountPaid: amount, method: 'CASH' }, idem());
        expect(res.status).toBe(201);
        payments.push({ paymentId: res.body.paymentId, invId: inv.id, amount, reversed: false });
        await assertInvariants(inv.id);
      } else if (op < 0.8) {
        // OVERPAY: more than remaining → must be refused and change nothing.
        const inv = pick(r, invoices);
        const remaining = TOTAL - netPaid(inv.id);
        const before = netPaid(inv.id);
        const res = await post(`/api/v1/fees/invoices/${inv.id}/payments`, { amountPaid: remaining + randInt(r, 1, 500), method: 'CASH' }, idem());
        // remaining===0 → invoice already PAID → 409; otherwise overpayment → 422. Either way: refused.
        expect([409, 422]).toContain(res.status);
        expect(netPaid(inv.id)).toBe(before);
        await assertInvariants(inv.id);
      } else {
        // REVERSE a random non-reversed payment.
        const live = payments.filter((p) => !p.reversed);
        if (!live.length) continue;
        const target = pick(r, live);
        const res = await post(`/api/v1/fees/payments/${target.paymentId}/reversals`, { reason: 'QA reversal' }, idem());
        expect(res.status).toBe(201);
        target.reversed = true;
        await assertInvariants(target.invId);
      }
    }

    // Global reconciliation across the whole ledger.
    let apiPaidSum = 0;
    for (const inv of invoices) {
      apiPaidSum += Number((await get(`/api/v1/fees/invoices/${inv.id}`)).body.paidAmount);
    }
    const oracleSum = payments.filter((p) => !p.reversed).reduce((s, p) => s + p.amount, 0);
    expect(apiPaidSum).toBeCloseTo(oracleSum, 2);
  }, 120_000);

  it('a fully reversed invoice is no longer PAID', async () => {
    // Pay one invoice in full, confirm PAID, reverse the covering payment(s), confirm it is not PAID.
    const inv = invoices[0];
    const remaining = TOTAL - netPaid(inv.id);
    if (remaining > 0) {
      const res = await post(`/api/v1/fees/invoices/${inv.id}/payments`, { amountPaid: remaining, method: 'CASH' }, idem());
      expect(res.status).toBe(201);
      payments.push({ paymentId: res.body.paymentId, invId: inv.id, amount: remaining, reversed: false });
    }
    expect((await get(`/api/v1/fees/invoices/${inv.id}`)).body.status).toBe('PAID');

    for (const p of payments.filter((p) => p.invId === inv.id && !p.reversed)) {
      const res = await post(`/api/v1/fees/payments/${p.paymentId}/reversals`, { reason: 'unwind' }, idem());
      expect(res.status).toBe(201);
      p.reversed = true;
    }
    const after = await get(`/api/v1/fees/invoices/${inv.id}`);
    expect(after.body.status).not.toBe('PAID');
    expect(Number(after.body.paidAmount)).toBeCloseTo(0, 2);
  }, 60_000);
});
