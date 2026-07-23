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
import { SmsService } from '../../apps/api/src/modules/comms/sms/sms.service';
import { SMS_QUEUE } from '../../apps/api/src/modules/comms/sms/sms.types';

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
    const klass = await post('/api/v1/classes', { campusId: prov.campusId, name: 'Grade 1', order: 1 });
    classId = klass.body.id;
    const section = await post('/api/v1/sections', { classId, name: 'A' });
    const student = await post('/api/v1/students', {
      fullName: 'Sara Khan', gender: 'FEMALE', dateOfBirth: '2020-05-10', classId, sectionId: section.body.id,
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
    const tables = [
      'auditLog', 'paymentReversal', 'feePayment', 'feeInvoiceItem', 'feeInvoice', 'feeInvoiceBatch',
      'discount', 'lateFeePolicy', 'feeStructure', 'feeHead', 'guardianCredit', 'idempotencyKey',
      'smsLog', 'smsCreditLedger', 'smsTemplate', 'studentGuardian', 'studentEnrollment', 'student',
      'inquiry', 'parentProfile', 'refreshToken', 'user', 'subject', 'section', 'class', 'academicYear', 'campus', 'school',
    ] as const;
    for (const t of tables) {
      const d = platform[t] as unknown as { deleteMany: (a: unknown) => Promise<unknown> };
      await d.deleteMany({ where: t === 'school' ? { id: schoolId } : { schoolId } }).catch(() => undefined);
    }
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
    // A past-month invoice to go overdue.
    await put('/api/v1/late-fee-policy', { graceDays: 0, mode: 'FLAT', amount: 100 });
    await post('/api/v1/fees/invoice-batches', { classId, month: 1, year: 2026 });
    const overdueList = await get(`/api/v1/fees/invoices?studentId=${studentId}&month=1&year=2026`);
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
    const created = await post('/api/v1/students', {
      fullName: 'Gone Soon', gender: 'MALE', dateOfBirth: '2020-02-02', classId, sectionId: section.body[0].id,
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
});
