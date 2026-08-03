import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { CLS_KEYS } from '@common';
import { PlatformPrismaService, TenantPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { admissionController } from './support/admission';
import { SmsService } from '../../apps/api/src/modules/comms/sms/sms.service';
import { SMS_QUEUE } from '../../apps/api/src/modules/comms/sms/sms.types';
import { destroyTenant } from './support/tenant';

/**
 * M4 gate (roadmap M4): collect-fee E2E + fee-integrity-check clean.
 * Exercises: fee head/structure/discount → idempotent invoice batch → payments
 * (Idempotency-Key replay, overpayment guard, partial→paid) → receipt SMS → reversal
 * → late-fee mark-overdue → waiver, with the integrity check green throughout.
 */
describe('Fees end-to-end (e2e, §12)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let cls: ClsService;
  let tenantPrisma: TenantPrismaService;
  let sms: SmsService;
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

  async function drainSms(): Promise<void> {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    for (const job of await queue.getJobs(['waiting', 'delayed', 'active', 'prioritized'])) {
      await cls.run(async () => {
        cls.set(CLS_KEYS.schoolId, schoolId);
        await tenantPrisma.withTenant(() => sms.dispatch(job.data));
      });
      await job.remove();
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
    cls = app.get(ClsService);
    tenantPrisma = app.get(TenantPrismaService);
    sms = app.get(SmsService, { strict: false });

    const provisioning = app.get(ProvisioningService, { strict: false });
    const prov = await provisioning.provisionSchool({ name: 'Fee School', subdomain: sub, ownerEmail: email, ownerPassword: password });
    schoolId = prov.schoolId;

    const login = await request(server()).post('/api/v1/auth/login').set('Host', host).send({ email, password });
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

  it('reverses a payment (OWNER_ADMIN) and recomputes the invoice', async () => {
    const rev = await post(`/api/v1/fees/payments/${firstPaymentId}/reversals`, { reason: 'Bounced cheque' });
    expect(rev.status).toBe(201);
    expect(rev.body.receiptNo).toMatch(/^RV-\d+$/);

    const inv = await get(`/api/v1/fees/invoices/${invoiceId}`);
    expect(inv.body.status).toBe('PARTIAL'); // 900 − reversed 500 = 400 paid
    expect(Number(inv.body.paidAmount)).toBe(400);

    const integrity = await get('/api/v1/fees/integrity-check');
    expect(integrity.body.ok).toBe(true);
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

    it('refuses a frequency that invoicing would never charge', async () => {
      // ONE_TIME and ADMISSION are in the enum but createBatch only applies MONTHLY and
      // ANNUAL, so accepting one would store a price that looks configured and bills nothing.
      const head = await post('/api/v1/fee-heads', { name: 'Admission Fee' });
      const res = await post('/api/v1/fee-structures', {
        classId: revClassId, feeHeadId: head.body.id, academicYearId: yearId,
        amount: 5000, frequency: 'ADMISSION',
      });
      expect(res.status).toBe(422);
      expect(res.body.error.message).toMatch(/never appear on a bill/i);
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
});
