import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { admissionController } from './support/admission';
import { SMS_QUEUE } from '../../apps/api/src/modules/comms/sms/sms.types';
import { destroyTenant } from './support/tenant';
import { drainSmsFor } from './support/sms';
import { loginRequest } from './support/login';

/**
 * M4 gate (roadmap M4): collect-fee E2E + fee-integrity-check clean.
 * Exercises: fee head/structure/discount → idempotent invoice batch → payments
 * (Idempotency-Key replay, overpayment guard, partial→paid) → receipt SMS → reversal
 * → late-fee mark-overdue → waiver, with the integrity check green throughout.
 */
describe('Fees end-to-end (e2e, §12)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let csrf: string;
  let classId: string;
  let yearId: string;
  let studentId: string;
  let parentId: string;
  let campusId: string;
  let admit: (dto: object) => request.Test;

  const sub = `fee-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const email = 'owner@fee.pk';
  const password = 'Owner!Secret12';

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object = {}, headers: Record<string, string> = {}) => {
    let r = request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(b);
  };
  const put = (p: string, b: object) =>
    request(server()).put(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).send(b);
  const get = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);
  const idem = () => ({ 'Idempotency-Key': randomUUID() });

  const drainSms = () => drainSmsFor(app, schoolId);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);

    const provisioning = app.get(ProvisioningService, { strict: false });
    const prov = await provisioning.provisionSchool({ name: 'Fee School', subdomain: sub, ownerEmail: email, ownerPassword: password });
    schoolId = prov.schoolId;

    const login = await loginRequest(server(), host, email, password);
    cookies = login.headers['set-cookie'] as unknown as string[];
    csrf = csrfOf(cookies);

    const year = await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    yearId = year.body.id;
    campusId = prov.campusId;
    const klass = await post('/api/v1/classes', { campusId, name: 'Grade 1', order: 1 });
    classId = klass.body.id;
    const section = await post('/api/v1/sections', { classId, name: 'A' });
    ({ admit } = await admissionController(app, platform, schoolId, host, campusId));
    const student = await admit({
      fullName: 'Sara Khan', gender: 'FEMALE', dateOfBirth: '2020-05-10', campusId, classId, sectionId: section.body.id,
      guardian: { mode: 'CREATE', fullName: 'Ali Khan', phone: '03007654321', relation: 'FATHER' },
    });
    studentId = student.body.studentId;
    parentId = student.body.parentId;
    await platform.parentProfile.updateMany({ where: { schoolId }, data: { phoneVerifiedAt: new Date() } });

    // Tuition 1000/month + a 10% discount for this student → invoice 900.
    const head = await post('/api/v1/fee-heads', { name: 'Tuition' });
    await post('/api/v1/fee-structures', { campusId: prov.campusId, classId, feeHeadId: head.body.id, academicYearId: yearId, amount: 1000, frequency: 'MONTHLY' });
    await post('/api/v1/discounts', { studentId, type: 'PERCENT', value: 10, reason: 'Sibling' });
  });

  afterAll(async () => {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  let invoiceId: string;
  let firstPaymentId: string;

  it('generates an idempotent invoice batch with the discount applied', async () => {
    const batch = await post('/api/v1/fees/invoice-batches', { classId, month: 7, year: 2026 });
    expect(batch.status).toBe(201);
    expect(batch.body).toMatchObject({ alreadyExists: false, generated: 1 });

    // Duplicate batch → existing, nothing regenerated.
    const dup = await post('/api/v1/fees/invoice-batches', { classId, month: 7, year: 2026 });
    expect(dup.body).toMatchObject({ alreadyExists: true, generated: 0 });

    const invoices = await get(`/api/v1/fees/invoices?studentId=${studentId}&month=7&year=2026`);
    expect(invoices.body.data).toHaveLength(1);
    invoiceId = invoices.body.data[0].id;
    expect(Number(invoices.body.data[0].totalAmount)).toBe(900); // 1000 − 10%
    expect(invoices.body.data[0].status).toBe('PENDING');
  });

  it('takes a partial payment; the Idempotency-Key replays instead of double-charging', async () => {
    const key = randomUUID();
    const body = { amountPaid: 500, method: 'CASH' };
    const first = await post(`/api/v1/fees/invoices/${invoiceId}/payments`, body, { 'Idempotency-Key': key });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ invoiceStatus: 'PARTIAL', paidAmount: 500 });
    firstPaymentId = first.body.paymentId;

    const replay = await post(`/api/v1/fees/invoices/${invoiceId}/payments`, body, { 'Idempotency-Key': key });
    expect(replay.body.paymentId).toBe(firstPaymentId); // same payment, not a new one
    expect(replay.body.receiptNo).toBe(first.body.receiptNo);
  });

  it('rejects overpayment (422 OVERPAYMENT_USE_ADVANCE) and completes to PAID', async () => {
    const over = await post(`/api/v1/fees/invoices/${invoiceId}/payments`, { amountPaid: 1000, method: 'CASH' }, idem());
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('OVERPAYMENT_USE_ADVANCE');

    const rest = await post(`/api/v1/fees/invoices/${invoiceId}/payments`, { amountPaid: 400, method: 'CASH' }, idem());
    expect(rest.status).toBe(201);
    expect(rest.body.invoiceStatus).toBe('PAID');
  });

  it('keeps the ledger consistent (fee-integrity-check green) and sends receipt SMS', async () => {
    const integrity = await get('/api/v1/fees/integrity-check');
    expect(integrity.body.ok).toBe(true);

    await drainSms();
    const receipts = await platform.smsLog.findMany({ where: { schoolId, templateKey: 'FEE_RECEIPT' } });
    expect(receipts.length).toBe(2); // two successful payments
    expect(receipts.every((r) => r.status === 'SENT')).toBe(true);
  });

  /**
   * The receipt PDF (B5). Rendered on demand, not stored at payment time: a receipt is a *view*
   * of the payment and the invoice around it, and both move afterwards.
   */
  it('serves the receipt as a real PDF, and refuses one for a reversed payment', async () => {
    const res = await get(`/api/v1/fees/payments/${firstPaymentId}/receipt`);
    expect(res.status).toBe(200);
    expect(res.body.url).toBeTruthy();

    // Actually fetch it: a presigned URL that 404s is the failure mode a status check misses.
    const pdf = await fetch(res.body.url);
    expect(pdf.status).toBe(200);
    const head = Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString();
    expect(head).toBe('%PDF-');
  });

  it('reverses a payment (OWNER_ADMIN) and recomputes the invoice', async () => {
    const rev = await post(`/api/v1/fees/payments/${firstPaymentId}/reversals`, { reason: 'Bounced cheque' });
    expect(rev.status).toBe(201);
    expect(rev.body.receiptNo).toMatch(/^RV-\d+$/);

    const inv = await get(`/api/v1/fees/invoices/${invoiceId}`);
    expect(inv.body.status).toBe('PARTIAL'); // 900 − reversed 500 = 400 paid
    expect(Number(inv.body.paidAmount)).toBe(400);

    const integrity = await get('/api/v1/fees/integrity-check');
    expect(integrity.body.ok).toBe(true);

    // A clean-looking receipt for money that has been reversed is how a receipt stops meaning
    // anything — so the same call that worked a moment ago is now refused, by name.
    const receipt = await get(`/api/v1/fees/payments/${firstPaymentId}/receipt`);
    expect(receipt.status).toBe(409);
    expect(receipt.body.error.message).toMatch(/reversed/i);
  });

  /**
   * The school chooses which ways it accepts money, and that choice is ENFORCED here rather
   * than merely hidden from the dropdown — an unenforced setting is decoration.
   */
  describe('accepted payment methods', () => {
    const setMethods = (methods: string[]) =>
      request(server()).patch('/api/v1/school-settings')
        .set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf)
        .send({ feeSubmission: { methods } });

    afterEach(async () => { await setMethods(['CASH', 'BANK_TRANSFER', 'EASYPAISA', 'JAZZCASH', 'CHEQUE', 'CARD']); });

    it('refuses a method the school does not accept, and names what it does', async () => {
      await setMethods(['CASH']);
      const batch = await post('/api/v1/fees/invoice-batches', { classId, month: 6, year: 2026 });
      expect(batch.body.generated).toBe(1);
      const inv = (await get(`/api/v1/fees/invoices?studentId=${studentId}&month=6&year=2026`)).body.data[0];

      const refused = await post(`/api/v1/fees/invoices/${inv.id}/payments`,
        { amountPaid: 100, method: 'JAZZCASH', transactionRef: 'JZ-1' }, idem());
      expect(refused.status).toBe(422);
      expect(refused.body.error.message).toMatch(/does not accept jazzcash/i);
      expect(refused.body.error.message).toMatch(/Accepted: CASH/);

      // ...and the accepted one still works, so this is a filter, not a freeze.
      const ok = await post(`/api/v1/fees/invoices/${inv.id}/payments`, { amountPaid: 100, method: 'CASH' }, idem());
      expect(ok.status).toBe(201);
    });

    it('still applies a guardian advance when the school takes cash only', async () => {
      // ADVANCE is not a way of paying — it is the school drawing down a credit the guardian
      // already deposited. Blocking it because "we only take cash" would strand real money.
      await setMethods(['CASH']);
      const dep = await post('/api/v1/fees/advances', { parentId, amount: 500 }, idem());
      expect(dep.status).toBe(201);

      const batch = await post('/api/v1/fees/invoice-batches', { classId, month: 11, year: 2026 });
      expect(batch.body.generated).toBe(1);
      const inv = (await get(`/api/v1/fees/invoices?studentId=${studentId}&month=11&year=2026`)).body.data[0];
      // The advance was applied during generation despite ADVANCE not being an "accepted method".
      expect(Number(inv.paidAmount)).toBeGreaterThan(0);
    });

    it('leaves payments already taken by a since-disabled method alone', async () => {
      // Switching a method off governs NEW payments only — money already collected stays
      // readable and reversible, the same rule as deactivating a fee structure.
      //
      // ⚠️ The example method is BANK_TRANSFER, not CHEQUE. This case is about DISABLING a method,
      // and it used a cheque only incidentally — but a cheque can no longer be collected directly
      // (D3: it is recorded as a submission and clears first), so using one here would have made
      // this test fail for a reason that has nothing to do with what it is testing.
      const batch = await post('/api/v1/fees/invoice-batches', { classId, month: 12, year: 2026 });
      expect(batch.body.generated).toBe(1);
      const inv = (await get(`/api/v1/fees/invoices?studentId=${studentId}&month=12&year=2026`)).body.data[0];
      const paid = await post(`/api/v1/fees/invoices/${inv.id}/payments`,
        { amountPaid: 100, method: 'BANK_TRANSFER', transactionRef: 'IBFT-9911' }, idem());
      expect(paid.status).toBe(201);

      await setMethods(['CASH']);
      // Filtered by method, which the payments list does support — the point is that the
      // payment is still THERE and readable after that method was switched off.
      const after = await get('/api/v1/fees/payments?method=BANK_TRANSFER');
      expect(after.status).toBe(200);
      expect(after.body.data.some((p: { id: string }) => p.id === paid.body.paymentId)).toBe(true);

      // And it is still reversible — a disabled method must not strand real money.
      const reversed = await post(`/api/v1/fees/payments/${paid.body.paymentId}/reversals`, { reason: 'Transfer recalled' });
      expect(reversed.status).toBe(201);
    });
  });

  /**
   * Proof of payment — the WhatsApp screenshot or stamped challan that justifies a non-cash
   * payment. Stored as a private storage key and read back only through a short-lived
   * presigned link, behind the same authorization as the payment itself.
   */
  describe('proof of payment', () => {
    const setPolicy = (proofPolicy: string) =>
      request(server()).patch('/api/v1/school-settings')
        .set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf)
        .send({ feeSubmission: { proofPolicy } });

    // Months must sit INSIDE the academic year (Apr 2026 – Mar 2027): a fee takes effect from
    // the year's first day, so billing a month before it generates nothing at all.
    const invoiceFor = async (month: number, year = 2026) => {
      const batch = await post('/api/v1/fees/invoice-batches', { classId, month, year });
      expect(batch.status).toBe(201);
      const inv = (await get(`/api/v1/fees/invoices?studentId=${studentId}&month=${month}&year=${year}`)).body.data[0];
      expect(inv).toBeDefined();
      return inv;
    };

    afterAll(async () => { await setPolicy('OPTIONAL'); });

    it('refuses a file key belonging to another school', async () => {
      // A stored key is a capability. Validating it at the moment it is ACCEPTED — rather than
      // when it is later presigned — is what stops one tenant attaching another's document.
      const inv = await invoiceFor(4);
      const res = await post(`/api/v1/fees/invoices/${inv.id}/payments`,
        { amountPaid: 50, method: 'BANK_TRANSFER', transactionRef: 'X-1', proofFileKey: 'uploads/00000000-0000-0000-0000-000000000000/evil.jpg' },
        idem());
      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/does not belong to your school/i);
    });

    it('when proof is REQUIRED, a non-cash payment without it is refused — but cash is not', async () => {
      await setPolicy('REQUIRED');
      const inv = await invoiceFor(10);

      const noProof = await post(`/api/v1/fees/invoices/${inv.id}/payments`,
        { amountPaid: 50, method: 'BANK_TRANSFER', transactionRef: 'NP-1' }, idem());
      expect(noProof.status).toBe(422);
      expect(noProof.body.error.message).toMatch(/requires proof of payment/i);

      // Cash over the counter has no screenshot, and demanding one would make the commonest
      // payment in a Pakistani school impossible to record.
      const cash = await post(`/api/v1/fees/invoices/${inv.id}/payments`, { amountPaid: 50, method: 'CASH' }, idem());
      expect(cash.status).toBe(201);
    });

    it('stores the proof and serves it back through a short-lived link', async () => {
      await setPolicy('OPTIONAL');
      const inv = await invoiceFor(1, 2027);
      const key = `uploads/${schoolId}/proof-${randomUUID()}.jpg`;
      const paid = await post(`/api/v1/fees/invoices/${inv.id}/payments`,
        { amountPaid: 50, method: 'JAZZCASH', transactionRef: `JZ-${randomUUID().slice(0, 8)}`, proofFileKey: key }, idem());
      expect(paid.status).toBe(201);

      const proof = await get(`/api/v1/fees/payments/${paid.body.paymentId}/proof`);
      expect(proof.status).toBe(200);
      // A signed URL, not the raw key: the object stays private and the link expires.
      expect(proof.body.url).toMatch(/^https?:\/\//);
      expect(proof.body.url).not.toContain(key.split('/').pop()!.replace('.jpg', '') + '"');
      expect(proof.body.expiresInSeconds).toBeGreaterThan(0);
    });

    it('never puts the storage key in a list — only that proof exists', async () => {
      // A key is how a file is addressed. Broadcasting it invites someone to try it where the
      // ownership check is weaker; the list therefore says only whether there IS proof.
      const list = await get('/api/v1/fees/payments?method=JAZZCASH');
      expect(list.status).toBe(200);
      const withProof = list.body.data.find((p: { hasProof: boolean }) => p.hasProof);
      expect(withProof).toBeDefined();
      expect(withProof).not.toHaveProperty('proofFileKey');
      expect(JSON.stringify(list.body)).not.toContain('uploads/');
    });

    it('says so plainly when a payment has no proof, rather than returning a broken link', async () => {
      const inv = await invoiceFor(2, 2027);
      const cash = await post(`/api/v1/fees/invoices/${inv.id}/payments`, { amountPaid: 50, method: 'CASH' }, idem());
      const proof = await get(`/api/v1/fees/payments/${cash.body.paymentId}/proof`);
      expect(proof.status).toBe(404);
      expect(proof.body.error.message).toMatch(/no proof was attached/i);
    });
  });

  /**
   * Payment claims. The property under test throughout is the one the whole design exists for:
   * **a claim is not a payment** until a human says the money arrived.
   */
  describe('payment claims', () => {
    const today = () => new Date().toISOString().slice(0, 10);
    const claimFor = (invoiceId: string, extra: object = {}) =>
      post('/api/v1/fees/claims', {
        invoiceId, amount: 100, method: 'BANK_TRANSFER',
        transactionRef: `IBFT-${randomUUID().slice(0, 8)}`, paidOn: today(), ...extra,
      });

    const invoiceFor = async (month: number, year = 2026) => {
      await post('/api/v1/fees/invoice-batches', { classId, month, year });
      const inv = (await get(`/api/v1/fees/invoices?studentId=${studentId}&month=${month}&year=${year}`)).body.data[0];
      expect(inv).toBeDefined();
      return inv;
    };

    /**
     * D3 — a cheque is not money until it clears.
     *
     * ⚠️ These pin the rule at the API, not the UI. "A display gate over an open endpoint is not a
     * rule" is already why `assertMethodAccepted` lives in the service; the same applies here, and
     * a cheque that can still be collected directly would make the whole clearing period cosmetic.
     */
    describe('cheques', () => {
      it('cannot be collected straight into a receipt', async () => {
        const inv = await invoiceFor(9, 2029);
        const res = await post(`/api/v1/fees/invoices/${inv.id}/payments`, { amountPaid: 100, method: 'CHEQUE', transactionRef: 'CHQ-001' })
          .set('Idempotency-Key', randomUUID());
        expect(res.status).toBe(422);
        expect(res.body.error.message).toMatch(/submission/i);
      });

      it('records a clearing date from the school settings', async () => {
        const inv = await invoiceFor(10, 2029);
        const claim = await claimFor(inv.id, { method: 'CHEQUE', transactionRef: `CHQ-${randomUUID().slice(0, 8)}` });
        expect(claim.status).toBe(201);
        expect(claim.body.clearsOn).toBeTruthy();
        // Default holding period is 3 days; the date is stored so a later settings change cannot
        // silently re-date a cheque already taken.
        const days = Math.round((new Date(claim.body.clearsOn).getTime() - new Date(claim.body.paidOn).getTime()) / 86_400_000);
        expect(days).toBe(3);
      });

      it('⚠️ cannot be verified before it clears — the bounced-cheque case', async () => {
        // Verifying early is how a family ends up holding a receipt for money the school never
        // received, and the school holding a reversal to unwind.
        const inv = await invoiceFor(11, 2029);
        const claim = await claimFor(inv.id, { method: 'CHEQUE', transactionRef: `CHQ-${randomUUID().slice(0, 8)}` });
        const res = await post(`/api/v1/fees/claims/${claim.body.id}/verify`);
        expect(res.status).toBe(409);
        expect(res.body.error.message).toMatch(/clears on/i);

        // The invoice is untouched, and no receipt was consumed.
        const after = (await get(`/api/v1/fees/invoices/${inv.id}`)).body;
        expect(Number(after.paidAmount)).toBe(0);
      });

      it('clears, and then verifies through the ordinary payment path', async () => {
        const inv = await invoiceFor(12, 2029);
        const claim = await claimFor(inv.id, { method: 'CHEQUE', transactionRef: `CHQ-${randomUUID().slice(0, 8)}` });
        // Reach past the holding period the way time would.
        await platform.feePaymentClaim.update({
          where: { id: claim.body.id },
          data: { clearsOn: new Date(Date.now() - 86_400_000) },
        });
        const res = await post(`/api/v1/fees/claims/${claim.body.id}/verify`);
        expect(res.status).toBe(201);
        // The receipt is minted by the SAME path every other method uses — not a second one.
        expect(res.body.receiptNo).toBeTruthy();
      });

      it('a bounced cheque is rejected, and nothing financial has to be unwound', async () => {
        const inv = await invoiceFor(1, 2030);
        const claim = await claimFor(inv.id, { method: 'CHEQUE', transactionRef: `CHQ-${randomUUID().slice(0, 8)}` });
        const res = await post(`/api/v1/fees/claims/${claim.body.id}/reject`, { reason: 'Cheque returned unpaid' });
        expect(res.status).toBe(201);
        const after = (await get(`/api/v1/fees/invoices/${inv.id}`)).body;
        expect(Number(after.paidAmount)).toBe(0);
      });
    });

    it('a pending claim moves NO money — the invoice is untouched', async () => {
      const inv = await invoiceFor(3, 2027);
      const before = Number(inv.paidAmount);

      const claim = await claimFor(inv.id);
      expect(claim.status).toBe(201);
      expect(claim.body.status).toBe('PENDING');
      expect(claim.body.paymentId).toBeNull();

      // The whole point: no receipt number consumed, nothing collected, defaulter unchanged.
      const after = (await get(`/api/v1/fees/invoices?studentId=${studentId}&month=3&year=2027`)).body.data[0];
      expect(Number(after.paidAmount)).toBe(before);
      expect(await platform.feePayment.count({ where: { invoiceId: inv.id } })).toBe(0);
    });

    it('verifying creates the real payment, with a receipt, and links the two', async () => {
      const inv = await invoiceFor(4, 2027);
      const claim = await claimFor(inv.id);

      const verified = await post(`/api/v1/fees/claims/${claim.body.id}/verify`);
      expect(verified.status).toBe(201);
      expect(verified.body.status).toBe('VERIFIED');
      expect(verified.body.receiptNo).toBeGreaterThan(0);

      // The bridge: from the claim you can reach the receipt it produced, and back again.
      const row = await platform.feePaymentClaim.findFirstOrThrow({ where: { id: claim.body.id } });
      expect(row.paymentId).not.toBeNull();
      const payment = await platform.feePayment.findFirstOrThrow({ where: { id: row.paymentId! } });
      expect(Number(payment.amountPaid)).toBe(100);

      // ...and the money actually moved this time.
      const after = (await get(`/api/v1/fees/invoices?studentId=${studentId}&month=4&year=2027`)).body.data[0];
      expect(Number(after.paidAmount)).toBe(100);
    });

    it('cannot be verified twice — one claim, one receipt', async () => {
      const inv = await invoiceFor(5, 2027);
      const claim = await claimFor(inv.id);
      await post(`/api/v1/fees/claims/${claim.body.id}/verify`);

      const again = await post(`/api/v1/fees/claims/${claim.body.id}/verify`);
      expect(again.status).toBe(409);
      expect(again.body.error.message).toMatch(/already verified/i);
      expect(await platform.feePayment.count({ where: { invoiceId: inv.id } })).toBe(1);
    });

    it('rejecting records the reason and leaves the invoice alone', async () => {
      const inv = await invoiceFor(6, 2027);
      const claim = await claimFor(inv.id);

      const rejected = await post(`/api/v1/fees/claims/${claim.body.id}/reject`, { reason: 'Reference not on our statement' });
      expect(rejected.status).toBe(201);
      expect(rejected.body).toMatchObject({ status: 'REJECTED', rejectionReason: 'Reference not on our statement' });
      expect(await platform.feePayment.count({ where: { invoiceId: inv.id } })).toBe(0);

      // A rejected claim is terminal — no quiet second chance that could double-collect.
      const late = await post(`/api/v1/fees/claims/${claim.body.id}/verify`);
      expect(late.status).toBe(409);
    });

    it('refuses a reference already submitted, so a resent screenshot is caught early', async () => {
      const inv = await invoiceFor(7, 2027);
      const ref = `IBFT-DUP-${randomUUID().slice(0, 6)}`;
      const first = await claimFor(inv.id, { transactionRef: ref });
      expect(first.status).toBe(201);

      const dupe = await claimFor(inv.id, { transactionRef: ref });
      expect(dupe.status).toBe(409);
      expect(dupe.body.error.message).toMatch(/already been submitted/i);
    });

    it('the office can record and verify in one action — the clerk took the money', async () => {
      const inv = await invoiceFor(8, 2027);
      const oneStep = await claimFor(inv.id, { autoVerify: true });
      expect(oneStep.status).toBe(201);
      expect(oneStep.body.status).toBe('VERIFIED');
      expect(oneStep.body.receiptNo).toBeGreaterThan(0);
    });

    it('the queue counts what is waiting, and never leaks the storage key', async () => {
      const count = await get('/api/v1/fees/claims/pending-count');
      expect(count.status).toBe(200);
      expect(count.body.pending).toBeGreaterThanOrEqual(1);

      const list = await get('/api/v1/fees/claims?status=PENDING');
      expect(list.status).toBe(200);
      expect(list.body.data[0]).toHaveProperty('hasProof');
      expect(JSON.stringify(list.body)).not.toContain('uploads/');
      // The queue is worked oldest-first — the family waiting longest goes first.
      expect(list.body.data[0].student).toHaveProperty('fullName');
    });
  });

  it('applies late fees via mark-overdue, then a waiver zeroes the balance', async () => {
    // A past-month invoice to go overdue. May 2026, not January: the academic year starts
    // 2026-04-01 and a fee now takes effect from the year's first day, so billing a month
    // BEFORE the year began produces nothing — which is correct, and which this fixture used
    // to rely on not being true.
    await put('/api/v1/late-fee-policy', { graceDays: 0, mode: 'FLAT', amount: 100 });
    await post('/api/v1/fees/invoice-batches', { classId, month: 5, year: 2026 });
    const overdueList = await get(`/api/v1/fees/invoices?studentId=${studentId}&month=5&year=2026`);
    const overdueId = overdueList.body.data[0].id;

    const marked = await post('/api/v1/fees/jobs/mark-overdue');
    expect(marked.body.marked).toBeGreaterThanOrEqual(1);

    const overdue = await get(`/api/v1/fees/invoices/${overdueId}`);
    expect(overdue.body.status).toBe('OVERDUE');
    expect(Number(overdue.body.totalAmount)).toBe(1000); // 900 + 100 fine

    const waived = await post(`/api/v1/fees/invoices/${overdueId}/waive`, { reason: 'Hardship' });
    expect(waived.body.status).toBe('WAIVED');

    const integrity = await get('/api/v1/fees/integrity-check');
    expect(integrity.body.ok).toBe(true);
  });

  it('records an advance deposit into the guardian ledger', async () => {
    const dep = await post('/api/v1/fees/advances', { parentId, amount: 2000 }, idem());
    expect(dep.status).toBe(201);
    expect(dep.body.balance).toBe(2000);

    const bal = await get(`/api/v1/fees/advances?parentId=${parentId}`);
    expect(bal.body.balance).toBe(2000);
  });

  it('auto-applies the guardian advance to a newly generated invoice (§12)', async () => {
    // parentId carries a 2000 advance from the previous test. Generate next month's batch.
    const batch = await post('/api/v1/fees/invoice-batches', { classId, month: 8, year: 2026 });
    expect(batch.body.generated).toBe(1);

    // Sara's month-8 invoice (tuition 1000 − 10% = 900) is auto-paid from the advance.
    const invs = await get(`/api/v1/fees/invoices?month=8&year=2026&studentId=${studentId}`);
    const inv = invs.body.data[0];
    expect(inv.status).toBe('PAID');
    expect(Number(inv.paidAmount)).toBe(900);

    // Balance drops by the applied amount; the ADVANCE payment keeps integrity green.
    const bal = await get(`/api/v1/fees/advances?parentId=${parentId}`);
    expect(bal.body.balance).toBe(1100);
    const integ = await get('/api/v1/fees/integrity-check');
    expect(integ.body.ok).toBe(true);
  });

  it('a removed student is withdrawn from their class and never billed again', async () => {
    const section = await get(`/api/v1/sections?classId=${classId}`);
    const created = await admit({
      fullName: 'Gone Soon', gender: 'MALE', dateOfBirth: '2020-02-02', campusId, classId, sectionId: section.body[0].id,
      guardian: { mode: 'CREATE', fullName: 'Parent Gone', phone: '03009998877', relation: 'FATHER' },
    });
    const goneId = created.body.studentId;

    // Removing the student must close the enrollment — an open one is what every downstream
    // read (rosters, head-count, invoicing) treats as a seated student.
    const removed = await request(server()).delete(`/api/v1/students/${goneId}`)
      .set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf);
    expect(removed.status).toBe(204);

    const enrolments = await platform.studentEnrollment.findMany({ where: { studentId: goneId } });
    expect(enrolments.every((e) => e.status !== 'ACTIVE')).toBe(true);

    // A fresh batch bills only the remaining student — the removed one gets no invoice.
    const batch = await post('/api/v1/fees/invoice-batches', { classId, month: 9, year: 2026 });
    expect(batch.body.generated).toBe(1);
    const gonesInvoices = await get(`/api/v1/fees/invoices?studentId=${goneId}&month=9&year=2026`);
    expect(gonesInvoices.body.data).toHaveLength(0);
  });

  /**
   * A fee revision is a NEW row starting from a later month, never an edit of the old one.
   * Without effective dating a school could not re-price mid-year at all — the unique key
   * allowed exactly one row per class/head/year/frequency — and changing a price would have
   * silently restated what families had already been billed.
   */
  describe('a mid-year price rise', () => {
    let revClassId: string;
    let tuitionId: string;
    let revStudentId: string;

    beforeAll(async () => {
      const klass = await post('/api/v1/classes', { campusId, name: 'Rev-Grade', order: 7 });
      revClassId = klass.body.id;
      const section = await post('/api/v1/sections', { classId: revClassId, name: 'A' });
      const student = await admit({
        fullName: 'Rev Pupil', gender: 'MALE', dateOfBirth: '2019-03-03', campusId,
        classId: revClassId, sectionId: section.body.id,
        // Unique per run: guardians are resolved BY PHONE, so a literal reused from another
        // test in this file links to that parent and 409s the CREATE.
        guardian: { mode: 'CREATE', fullName: 'Rev Parent', phone: `03${String(Date.now()).slice(-9)}`, relation: 'FATHER' },
      });
      expect(student.status).toBe(201);
      revStudentId = student.body.studentId;

      const head = await post('/api/v1/fee-heads', { name: 'Rev Tuition' });
      tuitionId = head.body.id;
      // 1,000 from the start of the year...
      await post('/api/v1/fee-structures', {
        campusId, classId: revClassId, feeHeadId: tuitionId, academicYearId: yearId,
        amount: 1000, frequency: 'MONTHLY', effectiveFrom: '2026-04-01',
      });
      // ...raised to 1,500 from September.
      const raise = await post('/api/v1/fee-structures', {
        campusId, classId: revClassId, feeHeadId: tuitionId, academicYearId: yearId,
        amount: 1500, frequency: 'MONTHLY', effectiveFrom: '2026-09-01',
      });
      expect(raise.status).toBe(201);
    });

    it('bills the old price before the rise and the new price after it', async () => {
      const august = await post('/api/v1/fees/invoice-batches', { classId: revClassId, month: 8, year: 2026 });
      expect(august.body.generated).toBe(1);
      const aug = await get(`/api/v1/fees/invoices?studentId=${revStudentId}&month=8&year=2026`);
      expect(Number(aug.body.data[0].totalAmount)).toBe(1000);

      const october = await post('/api/v1/fees/invoice-batches', { classId: revClassId, month: 10, year: 2026 });
      expect(october.body.generated).toBe(1);
      const oct = await get(`/api/v1/fees/invoices?studentId=${revStudentId}&month=10&year=2026`);
      // Only ONE tuition line, at the new price — the two rows are a history, not two charges.
      expect(Number(oct.body.data[0].totalAmount)).toBe(1500);
      const detail = await get(`/api/v1/fees/invoices/${oct.body.data[0].id}`);
      expect(detail.body.items.filter((i: { type: string }) => i.type === 'FEE')).toHaveLength(1);
    });

    it('leaves the invoice issued before the rise untouched', async () => {
      // The whole reason a revision is a new row: August was computed from August's price and
      // must still say 1,000 after the rise exists.
      const aug = await get(`/api/v1/fees/invoices?studentId=${revStudentId}&month=8&year=2026`);
      expect(Number(aug.body.data[0].totalAmount)).toBe(1000);
    });

    it('refuses to edit a price that has already been billed, and says what to do instead', async () => {
      const rows = await get(`/api/v1/fee-structures?classId=${revClassId}`);
      const april = rows.body.find((r: { effectiveFrom: string }) => r.effectiveFrom.startsWith('2026-04'));
      const res = await request(server()).patch(`/api/v1/fee-structures/${april.id}`)
        .set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).send({ amount: 1200 });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/revision starting from a later month/i);
      // Unchanged — a refused edit must not half-apply.
      const after = await get(`/api/v1/fee-structures?classId=${revClassId}`);
      expect(Number(after.body.find((r: { id: string }) => r.id === april.id).amount)).toBe(1000);
    });

    it('refuses to delete a billed price, but switching it off is always allowed', async () => {
      const rows = await get(`/api/v1/fee-structures?classId=${revClassId}`);
      const april = rows.body.find((r: { effectiveFrom: string }) => r.effectiveFrom.startsWith('2026-04'));

      const del = await request(server()).delete(`/api/v1/fee-structures/${april.id}`)
        .set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf);
      expect(del.status).toBe(409);
      expect(del.body.error.message).toMatch(/switch it off/i);

      // Deactivating only affects FUTURE runs, so it is never blocked.
      const off = await request(server()).patch(`/api/v1/fee-structures/${april.id}`)
        .set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).send({ isActive: false });
      expect(off.status).toBe(200);
      expect(off.body.isActive).toBe(false);
    });

    it('lets an unbilled typo be corrected outright', async () => {
      // The defect this whole change exists for: before it, a mis-keyed amount was permanent.
      const head = await post('/api/v1/fee-heads', { name: 'Typo Head' });
      const created = await post('/api/v1/fee-structures', {
        classId: revClassId, feeHeadId: head.body.id, academicYearId: yearId,
        amount: 30000, frequency: 'MONTHLY', effectiveFrom: '2027-02-01', // a month nothing has billed
      });
      expect(created.status).toBe(201);

      const fixed = await request(server()).patch(`/api/v1/fee-structures/${created.body.id}`)
        .set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).send({ amount: 3000 });
      expect(fixed.status).toBe(200);
      expect(Number(fixed.body.amount)).toBe(3000);
    });

    it('rejects a duplicate price with a clear 409, not a 500', async () => {
      const dupe = await post('/api/v1/fee-structures', {
        classId: revClassId, feeHeadId: tuitionId, academicYearId: yearId,
        amount: 1234, frequency: 'MONTHLY', effectiveFrom: '2026-09-01', // same head, same month
      });
      expect(dupe.status).toBe(409);
      expect(dupe.body.error.message).toMatch(/already has a price/i);
    });

    it('accepts a charge-once frequency now that invoicing bills it', async () => {
      // ⚠️ **This case asserted the OPPOSITE until 2026-08-12, and was right to.** ONE_TIME and
      // ADMISSION were in the enum while `createBatch` applied only MONTHLY and ANNUAL, so storing
      // such a price would have looked configured and billed nothing, for ever — the refusal is
      // what kept that gap visible instead of silent.
      //
      // B3 replaced the calendar question ("is it this month?", which no one-off charge can answer)
      // with a ledger one ("has this student been charged it on this enrolment?"), so the reason
      // for the refusal is gone and the guard was retired with it. **A test that encodes a decision
      // is evidence: when the decision moves, the case is rewritten to the half that still means
      // something — not deleted quietly.** That the fee is billed exactly once is asserted in
      // "bills an ADMISSION fee once, and not again on the next invoice".
      const head = await post('/api/v1/fee-heads', { name: 'Admission Fee' });
      const res = await post('/api/v1/fee-structures', {
        classId: revClassId, feeHeadId: head.body.id, academicYearId: yearId,
        amount: 5000, frequency: 'ADMISSION',
      });
      expect(res.status).toBe(201);
    });

    it('renames a fee, and refuses to delete one that is still in use', async () => {
      // Fee heads were create-and-read only, so the school's list only ever grew — every typo
      // and every name a test run left behind stayed in the dropdown for ever.
      const head = await post('/api/v1/fee-heads', { name: `Lab-${Date.now()}` });
      const renamed = await request(server()).patch(`/api/v1/fee-heads/${head.body.id}`)
        .set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).send({ name: 'Laboratory' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.name).toBe('Laboratory');

      // Unused ⇒ removable.
      const gone = await request(server()).delete(`/api/v1/fee-heads/${head.body.id}`)
        .set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf);
      expect(gone.status).toBe(204);

      // In use ⇒ refused, naming what uses it, so the invoices it produced stay explicable.
      const blocked = await request(server()).delete(`/api/v1/fee-heads/${tuitionId}`)
        .set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.message).toMatch(/still used by .*class price/i);
    });

    it('refuses a duplicate fee name with a clear 409', async () => {
      const dupe = await post('/api/v1/fee-heads', { name: 'Rev Tuition' });
      expect(dupe.status).toBe(409);
      expect(dupe.body.error.message).toMatch(/already have a fee called/i);
    });

    it('copies a plan to another class, with an across-the-board rise', async () => {
      const target = await post('/api/v1/classes', { campusId, name: 'Copy-Grade', order: 8 });
      const res = await post('/api/v1/fee-structures/copy', {
        fromClassId: revClassId, fromAcademicYearId: yearId,
        toClassIds: [target.body.id], raisePercent: 10, effectiveFrom: '2026-04-01',
      });
      expect(res.status).toBe(201);
      expect(res.body.created).toBeGreaterThan(0);

      const copied = await get(`/api/v1/fee-structures?classId=${target.body.id}`);
      const tuition = copied.body.find((r: { feeHeadId: string }) => r.feeHeadId === tuitionId);
      // Only the price IN FORCE is copied (1500, the September revision), not the whole
      // history — a revision that happened in 9th did not happen in the new class.
      expect(Number(tuition.amount)).toBe(1650); // 1500 + 10%, rounded to whole rupees

      // Re-running skips rather than duplicating or restating a price somebody set.
      const again = await post('/api/v1/fee-structures/copy', {
        fromClassId: revClassId, fromAcademicYearId: yearId,
        toClassIds: [target.body.id], raisePercent: 10, effectiveFrom: '2026-04-01',
      });
      expect(again.body).toMatchObject({ created: 0 });
      expect(again.body.skipped).toBeGreaterThan(0);
    });
  });

  /**
   * The guardian upload link (§5.2) — the product's only PUBLIC, unauthenticated write surface.
   *
   * Its whole security model is the signed token, so these assertions are the security model:
   * a tampered token, an expired one and a disabled school must all be refused, and the page
   * must not become a window into the student record.
   */
  describe('guardian upload link', () => {
    const setLink = (on: boolean) =>
      request(server()).patch('/api/v1/school-settings')
        .set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf)
        .send({ feeSubmission: { guardianUploadLink: on } });

    /** Public: deliberately NO cookie and NO CSRF header — only the Host, which picks the tenant. */
    const pub = (path: string) => request(server()).get(path).set('Host', host);
    const pubPost = (path: string, body: object) =>
      request(server()).post(path).set('Host', host).send(body);

    let linkInvoiceId: string;
    let token: string;

    beforeAll(async () => {
      await setLink(true);

      // Its OWN class, student and fee plan. Two collisions made the shared fixtures unusable:
      // Sara carries a guardian advance that auto-pays her next invoice the moment it exists, and
      // invoice batches are idempotent per (class, month, year) — so every month this class had
      // already been billed in returned `generated: 0` and left a brand-new student with no
      // invoice at all. Hunting for an unused month is a fixture that breaks the next time
      // somebody adds a test above this one.
      const klass = await post('/api/v1/classes', { campusId, name: 'Link Grade', order: 9 });
      const linkClassId = klass.body.id;
      const section = await post('/api/v1/sections', { classId: linkClassId, name: 'A' });
      const head = await post('/api/v1/fee-heads', { name: 'Link Tuition' });
      await post('/api/v1/fee-structures', {
        campusId, classId: linkClassId, feeHeadId: head.body.id,
        academicYearId: yearId, amount: 1000, frequency: 'MONTHLY',
      });
      const child = await admit({
        fullName: 'Bilal Ahmed', gender: 'MALE', dateOfBirth: '2019-03-03',
        campusId, classId: linkClassId, sectionId: section.body.id,
        guardian: { mode: 'CREATE', fullName: 'Nadia Ahmed', phone: '03331234567', relation: 'MOTHER' },
      });
      await post('/api/v1/fees/invoice-batches', { classId: linkClassId, month: 9, year: 2026 });
      const invs = await get(`/api/v1/fees/invoices?studentId=${child.body.studentId}&month=9&year=2026`);
      linkInvoiceId = invs.body.data[0].id;
      const issued = await post(`/api/v1/fees/invoices/${linkInvoiceId}/guardian-link`, {});
      expect(issued.status).toBe(201);
      token = issued.body.token;
      expect(issued.body.url).toContain(`/p/${token}`);
    });

    afterAll(async () => { await setLink(false); });

    it('shows the payer their own bill — first name only, nothing else about the child', async () => {
      const res = await pub(`/api/v1/public/fee-link/${token}`);
      expect(res.status).toBe(200);
      expect(res.body.studentFirstName).toBe('Bilal');     // "Bilal Ahmed" → first name only
      expect(Number(res.body.outstanding)).toBeGreaterThan(0);
      // A link travels by SMS and gets forwarded: it must not carry the record with it.
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('Ahmed');                 // no surname, no guardian name
      expect(res.body.grNumber).toBeUndefined();
      expect(res.body.studentId).toBeUndefined();
      expect(res.body.invoiceId).toBeUndefined();
    });

    it('refuses a tampered token — the signature covers the invoice id', async () => {
      // Re-encode the payload for a DIFFERENT invoice, keeping the original signature. This is
      // the attack the HMAC exists for: one valid link must not become a link to every invoice.
      const [body, sig] = token.split('.');
      const payload = Buffer.from(body, 'base64url').toString('utf8');
      const swapped = payload.replace(/^[^.]+/, invoiceId);
      const forged = `${Buffer.from(swapped).toString('base64url')}.${sig}`;
      expect((await pub(`/api/v1/public/fee-link/${forged}`)).status).toBe(404);

      // And a flipped signature byte.
      const flipped = `${body}.${sig.slice(0, -1)}${sig.slice(-1) === 'A' ? 'B' : 'A'}`;
      expect((await pub(`/api/v1/public/fee-link/${flipped}`)).status).toBe(404);
      expect((await pub('/api/v1/public/fee-link/not-a-token')).status).toBe(404);
    });

    // Runs BEFORE the claim test below: once a PENDING claim exists the one-at-a-time rule
    // answers first with a 409, and this assertion would be testing that instead.
    it('refuses a method the school does not accept', async () => {
      const res = await pubPost(`/api/v1/public/fee-link/${token}/claim`, {
        amount: 100, method: 'ADVANCE', transactionRef: 'GL-3', paidOn: '2026-09-05',
      });
      expect([400, 422]).toContain(res.status);
    });

    it('creates a PENDING claim that moves no money, and refuses a second one', async () => {
      const before = await get(`/api/v1/fees/invoices/${linkInvoiceId}`);
      const paidBefore = Number(before.body.paidAmount);

      const res = await pubPost(`/api/v1/public/fee-link/${token}/claim`, {
        amount: 100, method: 'BANK_TRANSFER', transactionRef: 'GL-1', paidOn: '2026-09-05',
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('PENDING');

      // The claim is a statement, not a payment: the invoice must be untouched.
      const after = await get(`/api/v1/fees/invoices/${linkInvoiceId}`);
      expect(Number(after.body.paidAmount)).toBe(paidBefore);

      // It lands in the office queue attributed to the link, with nobody as the submitter.
      const queued = (await get('/api/v1/fees/claims?status=PENDING')).body.data
        .find((c: { transactionRef: string }) => c.transactionRef === 'GL-1');
      expect(queued).toMatchObject({ source: 'GUARDIAN_LINK', status: 'PENDING' });

      // A forwarded link must not become an unbounded write surface.
      const second = await pubPost(`/api/v1/public/fee-link/${token}/claim`, {
        amount: 100, method: 'BANK_TRANSFER', transactionRef: 'GL-2', paidOn: '2026-09-05',
      });
      expect(second.status).toBe(409);
    });

    it('is invisible while the school has it switched off', async () => {
      await setLink(false);
      // 404, not 403: an unconfigured school should not confirm the surface exists.
      expect((await pub(`/api/v1/public/fee-link/${token}`)).status).toBe(404);
      expect((await post(`/api/v1/fees/invoices/${linkInvoiceId}/guardian-link`, {})).status).toBe(404);
      await setLink(true);
    });
  });

  /**
   * The aggregator seam (§5.3) — a stub, and the tests say so.
   *
   * What is asserted is what is real: the endpoint exists, it is public, and it **fails closed**.
   * Nothing here pretends settlement works, because it does not — but the failure modes that
   * would matter on the day it does are pinned now, while they are cheap to get right.
   */
  describe('aggregator settlement seam', () => {
    const settle = (body: object, signature?: string) => {
      const r = request(server()).post('/api/v1/webhooks/fee-settlement/kuickpay').set('Host', host);
      return (signature ? r.set('X-Signature', signature) : r).send(body);
    };

    it('refuses every call while no aggregator secret is configured', async () => {
      // The dev/test env sets no AGGREGATOR_WEBHOOK_HMAC_SECRET, which is the point: an
      // unconfigured deployment must refuse rather than fall through to "unsigned is fine".
      const res = await settle({ psid: '0001234567890', amount: 900, aggregatorRef: 'KP-1' }, 'deadbeef');
      expect(res.status).toBe(403);

      // Unsigned is refused identically — no secret means nothing is acceptable.
      expect((await settle({ psid: '0001234567890', amount: 900, aggregatorRef: 'KP-2' })).status).toBe(403);
    });

    it('validates the payload before it does anything else', async () => {
      // No session and no CSRF: this is a @Public route, so the DTO is the first line of defence.
      const res = await settle({ psid: 'x', amount: -5 }, 'deadbeef');
      expect([400, 403, 422]).toContain(res.status);
    });

    it('carries the PSID column and the ONLINE method the seam is built on', async () => {
      // The schema half of B6 — a column and an enum value nothing uses yet. Asserted because a
      // migration that silently failed to apply would otherwise surface months later, when an
      // aggregator contract is signed and everyone assumes this part was done.
      const invoice = await platform.feeInvoice.findFirst({ where: { schoolId }, select: { psid: true } });
      expect(invoice).toHaveProperty('psid', null);

      const methods = await platform.$queryRawUnsafe<{ v: string }[]>(
        `SELECT unnest(enum_range(NULL::"PaymentMethod"))::text AS v`,
      );
      expect(methods.map((m) => m.v)).toContain('ONLINE');
    });
  });

  // ── B1: invoice ONE student ─────────────────────────────────────────────────
  describe('invoicing a single student', () => {
    const key = () => randomUUID();

    it('bills a child admitted AFTER their class was already batched', async () => {
      // ⚠️ The case that has no answer without this route. A (class, month, year) can be billed
      // once EVER — createBatch returns early on an existing batch — so before B1 a mid-session
      // admission simply could not be invoiced. Mid-session admissions are normal.
      const month = 4;
      const year = 2031;
      const batch = await post('/api/v1/fees/invoice-batches', { classId, month, year });
      expect(batch.status).toBe(201);

      const section = await get(`/api/v1/sections?classId=${classId}`);
      const latecomer = await admit({
        fullName: 'Late Comer', gender: 'MALE', dateOfBirth: '2020-02-02', campusId, classId,
        sectionId: section.body[0].id,
        guardian: { mode: 'CREATE', fullName: 'Parent Two', phone: '03001112233', relation: 'FATHER' },
      });

      expect(latecomer.body.studentId).toBeTruthy();

      // The batch cannot help: re-running it generates nothing at all.
      const rerun = await post('/api/v1/fees/invoice-batches', { classId, month, year });
      expect(rerun.body.generated).toBe(0);

      const res = await post('/api/v1/fees/invoices',
        { studentId: latecomer.body.studentId, month, year }, { 'Idempotency-Key': key() });
      expect(res.status).toBe(201);

      const invoices = await get(`/api/v1/fees/invoices?studentId=${latecomer.body.studentId}&month=${month}&year=${year}`);
      expect(invoices.body.data).toHaveLength(1);
      expect(Number(invoices.body.data[0].totalAmount)).toBe(1000);
    });

    it('is idempotent — the same key twice yields ONE invoice', async () => {
      const month = 5;
      const year = 2031;
      const k = key();
      const first = await post('/api/v1/fees/invoices', { studentId, month, year }, { 'Idempotency-Key': k });
      const replay = await post('/api/v1/fees/invoices', { studentId, month, year }, { 'Idempotency-Key': k });
      expect(first.status).toBe(201);

      // The endpoint speaks the same {status, body, replayed} envelope as `pay`: a replay returns
      // the ORIGINAL invoice id rather than doing the work again, and says that it did.
      expect(first.body.replayed).toBe(false);
      expect(replay.body.replayed).toBe(true);
      expect(replay.body.body.invoiceId).toBe(first.body.body.invoiceId);

      const invoices = await get(`/api/v1/fees/invoices?studentId=${studentId}&month=${month}&year=${year}`);
      expect(invoices.body.data).toHaveLength(1);
    });

    it('refuses a second invoice for a period the student already has', async () => {
      // Belt and braces: a DIFFERENT idempotency key must still not double-bill, because the
      // service checks and — if that ever fails under concurrency — B0's index refuses the row.
      const month = 6;
      const year = 2031;
      await post('/api/v1/fees/invoices', { studentId, month, year }, { 'Idempotency-Key': key() });
      const second = await post('/api/v1/fees/invoices', { studentId, month, year }, { 'Idempotency-Key': key() });
      expect(second.status).toBe(409);
    });

    it('requires an Idempotency-Key', async () => {
      const res = await post('/api/v1/fees/invoices', { studentId, month: 7, year: 2031 });
      expect(res.status).toBe(400);
    });

    it('404s a student with no active enrollment rather than inventing one', async () => {
      const res = await post('/api/v1/fees/invoices',
        { studentId: randomUUID(), month: 8, year: 2031 }, { 'Idempotency-Key': key() });
      expect(res.status).toBe(404);
    });

    it('applies the same discounts as the batch path — one pricing path, not two', async () => {
      // The seeded student carries a 10% discount, so the batch bills 900. The per-student route
      // must agree; if the two ever diverge, a family is charged differently depending on which
      // button the office pressed.
      const month = 9;
      const year = 2031;
      await post('/api/v1/fees/invoices', { studentId, month, year }, { 'Idempotency-Key': key() });
      const invoices = await get(`/api/v1/fees/invoices?studentId=${studentId}&month=${month}&year=${year}`);
      expect(Number(invoices.body.data[0].totalAmount)).toBe(900);
    });
  });

  // ── B2 + B3: the sibling discount, and charges billed once ──────────────────
  describe('sibling discount and charge-once heads', () => {
    const setSibling = (percent: number) =>
      request(server()).patch('/api/v1/school-settings')
        .set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf)
        .send({ siblingDiscountPercent: percent });

    afterEach(async () => { await setSibling(0); });

    /**
     * Admit a child under a guardian, LINKING to that parent when they already exist.
     *
     * ⚠️ Two `CREATE`s with one phone do not make siblings — they make two parents, and the rank
     * is computed from the shared PRIMARY guardian. The first draft did exactly that and the
     * discount never appeared, which read as "the feature does not work" rather than "the fixture
     * built the wrong family".
     */
    const admitUnder = async (fullName: string, parentId?: string, phone?: string) => {
      const section = await get(`/api/v1/sections?classId=${classId}`);
      const res = await admit({
        fullName, gender: 'MALE', dateOfBirth: '2019-01-01', campusId, classId, sectionId: section.body[0].id,
        guardian: parentId
          ? { mode: 'LINK', parentId, relation: 'FATHER' }
          : { mode: 'CREATE', fullName: 'Shared Parent', phone, relation: 'FATHER' },
      });
      expect(res.body.studentId).toBeTruthy(); // a broken fixture must not read as broken billing
      return { studentId: res.body.studentId as string, parentId: res.body.parentId as string };
    };

    it('discounts the SECOND child and leaves the first at full price', async () => {
      // ⚠️ The defect this closes: `siblingDiscountPercent` existed in the schema, the DTO, the API
      // types AND the settings screen while being read by nothing. An owner could set 20%, see a
      // success toast, and no invoice was ever a rupee cheaper — silently overcharging families.
      const first = await admitUnder('Elder Child', undefined, '03211234567');
      const elder = first.studentId;
      const younger = (await admitUnder('Younger Child', first.parentId)).studentId;
      await setSibling(50);

      const month = 3;
      const year = 2032;
      for (const sid of [elder, younger]) {
        await post('/api/v1/fees/invoices', { studentId: sid, month, year }, { 'Idempotency-Key': randomUUID() });
      }

      const elderInv = await get(`/api/v1/fees/invoices?studentId=${elder}&month=${month}&year=${year}`);
      const youngerInv = await get(`/api/v1/fees/invoices?studentId=${younger}&month=${month}&year=${year}`);
      expect(Number(elderInv.body.data[0].totalAmount)).toBe(1000);
      expect(Number(youngerInv.body.data[0].totalAmount)).toBe(500);
    });

    it('says WHY on the invoice — the reason is what makes historising the setting unnecessary', async () => {
      const born = await admitUnder('First Born', undefined, '03211234568');
      const second = (await admitUnder('Second Born', born.parentId)).studentId;
      await setSibling(25);

      const month = 4;
      const year = 2032;
      await post('/api/v1/fees/invoices', { studentId: second, month, year }, { 'Idempotency-Key': randomUUID() });

      const inv = await get(`/api/v1/fees/invoices?studentId=${second}&month=${month}&year=${year}`);
      const detail = await get(`/api/v1/fees/invoices/${inv.body.data[0].id}`);
      const line = detail.body.items.find((i: { type: string }) => i.type === 'DISCOUNT');
      expect(line.description).toMatch(/Sibling discount \(child 2, 25%\)/);
    });

    it('⚠️ at 0% there is NO discount line — the test must depend on the setting', async () => {
      // Without this the two cases above would pass against an implementation that discounted
      // everybody unconditionally.
      const alpha = await admitUnder('Alpha Child', undefined, '03211234569');
      const second = (await admitUnder('Beta Child', alpha.parentId)).studentId;
      await setSibling(0);

      const month = 5;
      const year = 2032;
      await post('/api/v1/fees/invoices', { studentId: second, month, year }, { 'Idempotency-Key': randomUUID() });
      const inv = await get(`/api/v1/fees/invoices?studentId=${second}&month=${month}&year=${year}`);
      expect(Number(inv.body.data[0].totalAmount)).toBe(1000);
    });

    it('an only child is never ranked second', async () => {
      await setSibling(50);
      const solo = (await admitUnder('Only Child', undefined, '03219876543')).studentId;
      const month = 6;
      const year = 2032;
      await post('/api/v1/fees/invoices', { studentId: solo, month, year }, { 'Idempotency-Key': randomUUID() });
      const inv = await get(`/api/v1/fees/invoices?studentId=${solo}&month=${month}&year=${year}`);
      expect(Number(inv.body.data[0].totalAmount)).toBe(1000);
    });

    it('bills an ADMISSION fee once, and not again on the next invoice', async () => {
      // ⚠️ Before B3 this could not be billed AT ALL: billing asked "is it this month?", which no
      // one-off charge can answer, so the admission fee was collected off-book.
      const head = await post('/api/v1/fee-heads', { name: `Admission ${randomUUID().slice(0, 6)}` });
      const st = await post('/api/v1/fee-structures', {
        campusId, classId, feeHeadId: head.body.id, academicYearId: yearId, amount: 5000, frequency: 'ADMISSION',
      });
      // Until B3 this was refused outright: "Invoicing does not yet charge ADMISSION fees."
      expect(st.status).toBe(201);
      const fresh = (await admitUnder('Brand New', undefined, '03215550001')).studentId;

      const first = await post('/api/v1/fees/invoices',
        { studentId: fresh, month: 7, year: 2032 }, { 'Idempotency-Key': randomUUID() });
      expect(first.status).toBe(201);
      const inv1 = await get(`/api/v1/fees/invoices?studentId=${fresh}&month=7&year=2032`);
      expect(Number(inv1.body.data[0].totalAmount)).toBe(6000); // 1000 tuition + 5000 admission

      await post('/api/v1/fees/invoices',
        { studentId: fresh, month: 8, year: 2032 }, { 'Idempotency-Key': randomUUID() });
      const inv2 = await get(`/api/v1/fees/invoices?studentId=${fresh}&month=8&year=2032`);
      expect(Number(inv2.body.data[0].totalAmount)).toBe(1000); // tuition only — charged once
    });
  });

  // ── B0: the invoice key is enforced by the DATABASE ─────────────────────────
  describe('one invoice per student per period', () => {
    /**
     * ⚠️ Asserted against the DATABASE, not through the service.
     *
     * The service's duplicate check is a read-then-write: two concurrent requests both pass it.
     * What actually prevents a family being billed twice for one month is the unique index — so
     * that is what this test exercises, by inserting directly on the platform (BYPASSRLS)
     * connection and expecting Postgres to refuse.
     *
     * The index used to be `WHERE batch_id IS NOT NULL`, covering only batch-generated rows. The
     * per-student path (B1) creates invoices with **no batch**, which would have landed in the
     * uncovered half — billed once by the batch and once ad hoc, with no complaint from the
     * database. This case is what stops that being reintroduced.
     */
    it('refuses a second invoice for the same (student, month, year) — even with no batch', async () => {
      const existing = await platform.feeInvoice.findFirstOrThrow({ where: { schoolId, studentId } });

      await expect(
        platform.feeInvoice.create({
          data: {
            schoolId,
            studentId,
            enrollmentId: existing.enrollmentId,
            batchId: null, // ← the case the old partial index did not cover
            month: existing.month,
            year: existing.year,
            totalAmount: existing.totalAmount,
            dueDate: existing.dueDate,
            status: 'PENDING',
          },
        }),
      ).rejects.toThrow();
    });

    it('still allows the SAME student a different month — the key is the period, not the student', async () => {
      // Without this, an index over (school, student) alone would pass every assertion above while
      // making monthly billing impossible after the first month.
      const existing = await platform.feeInvoice.findFirstOrThrow({ where: { schoolId, studentId } });
      const other = await platform.feeInvoice.create({
        data: {
          schoolId,
          studentId,
          enrollmentId: existing.enrollmentId,
          batchId: null,
          month: 12,
          year: 2099,
          totalAmount: existing.totalAmount,
          dueDate: existing.dueDate,
          status: 'PENDING',
        },
      });
      expect(other.id).toBeTruthy();
      await platform.feeInvoice.delete({ where: { id: other.id } });
    });
  });
});
