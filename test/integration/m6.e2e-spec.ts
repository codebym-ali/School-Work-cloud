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

/**
 * M6 gate (roadmap M6): promotion E2E + all seven reports export.
 * Also covers payroll compute, certificate issuance, dashboard and audit browser.
 */
describe('M6 — HR, payroll, documents, reports, promotion (e2e)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let csrf: string;
  let campusId: string;
  let grade1SectionA: string;
  let targetYearId: string;
  let studentId: string;

  const sub = `m6-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const email = 'owner@m6.pk';
  const password = 'Owner!Secret12';

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object = {}) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).send(b);
  const get = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const prov = await app.get(ProvisioningService, { strict: false }).provisionSchool({ name: 'M6 School', subdomain: sub, ownerEmail: email, ownerPassword: password });
    schoolId = prov.schoolId;
    campusId = prov.campusId;
    const login = await request(server()).post('/api/v1/auth/login').set('Host', host).send({ email, password });
    cookies = login.headers['set-cookie'] as unknown as string[];
    csrf = csrfOf(cookies);

    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    // Target year for promotion — NOT current.
    targetYearId = (await post('/api/v1/academic-years', { name: '2027-28', startDate: '2027-04-01', endDate: '2028-03-31' })).body.id;

    const g1 = (await post('/api/v1/classes', { campusId, name: 'Grade 1', order: 1 })).body.id;
    const g2 = (await post('/api/v1/classes', { campusId, name: 'Grade 2', order: 2 })).body.id;
    grade1SectionA = (await post('/api/v1/sections', { classId: g1, name: 'A' })).body.id;
    await post('/api/v1/sections', { classId: g2, name: 'A' }); // promotion target section

    const student = await post('/api/v1/students', {
      fullName: 'Sara Khan', gender: 'FEMALE', dateOfBirth: '2020-05-10', classId: g1, sectionId: grade1SectionA,
      guardian: { mode: 'CREATE', fullName: 'Ali Khan', phone: '03007654321', relation: 'FATHER' },
    });
    studentId = student.body.studentId;
  });

  afterAll(async () => {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    const tables = [
      'auditLog', 'payslip', 'payrollRun', 'salaryStructure', 'teacherAssignment', 'document', 'reportCard',
      'examResult', 'examDefinition', 'term', 'gradeScale', 'paymentReversal', 'feePayment', 'feeInvoiceItem',
      'feeInvoice', 'feeInvoiceBatch', 'discount', 'lateFeePolicy', 'feeStructure', 'feeHead', 'guardianCredit',
      'idempotencyKey', 'smsLog', 'smsCreditLedger', 'smsTemplate', 'studentGuardian', 'studentEnrollment',
      'student', 'inquiry', 'parentProfile', 'refreshToken', 'staffProfile', 'user', 'subject', 'section',
      'class', 'academicYear', 'campus', 'school',
    ] as const;
    for (const t of tables) {
      const d = platform[t] as unknown as { deleteMany: (a: unknown) => Promise<unknown> };
      await d.deleteMany({ where: t === 'school' ? { id: schoolId } : { schoolId } }).catch(() => undefined);
    }
    await app.close();
  });

  it('promotes a section to the next class/year (idempotent)', async () => {
    const res = await post('/api/v1/promotions', { sectionId: grade1SectionA, targetYearId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ promoted: 1, skipped: 0 });

    const active = await get(`/api/v1/enrollments?studentId=${studentId}&status=ACTIVE`);
    expect(active.body.data).toHaveLength(1);
    expect(active.body.data[0].academicYearId).toBe(targetYearId);

    // Re-run is a no-op: the source section has no ACTIVE enrollments left, so nothing
    // is promoted and the student keeps exactly one active enrollment (no double-promote).
    const again = await post('/api/v1/promotions', { sectionId: grade1SectionA, targetYearId });
    expect(again.body.promoted).toBe(0);
    const stillActive = await get(`/api/v1/enrollments?studentId=${studentId}&status=ACTIVE`);
    expect(stillActive.body.data).toHaveLength(1);
  });

  it('exports all seven reports as JSON, CSV and PDF', async () => {
    const reports = [
      `daily-collection?date=2026-07-01`,
      `fee-ledger?studentId=${studentId}`,
      `attendance-register?sectionId=${grade1SectionA}&from=2026-07-01&to=2026-07-31`,
      `class-strength`,
      `defaulters`,
      `exam-summary?examId=${randomUUID()}`,
      `sms-usage`,
    ];
    for (const r of reports) {
      const json = await get(`/api/v1/reports/${r}`);
      expect(json.status).toBe(200);
      const sep = r.includes('?') ? '&' : '?';

      const csv = await get(`/api/v1/reports/${r}${sep}format=csv`);
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv');

      const pdf = await get(`/api/v1/reports/${r}${sep}format=pdf`).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      expect(pdf.headers['content-disposition']).toContain('.pdf');
      expect((pdf.body as Buffer).subarray(0, 4).toString('latin1')).toBe('%PDF'); // real PDF bytes
    }
  });

  it('runs payroll: gross = basic (+allowances), net after deductions', async () => {
    const staff = await post('/api/v1/staff', { email: 'teacher@m6.pk', staffType: 'TEACHER', employeeCode: 'T-001', designation: 'Teacher', joinedAt: '2026-04-01', campusId });
    expect(staff.status).toBe(201);
    await post(`/api/v1/staff/${staff.body.staffId}/salary-structures`, { basic: 50000, allowances: { House: 10000 }, effectiveFrom: '2026-04-01' });

    const run = await post('/api/v1/payroll-runs', { campusId, month: 7, year: 2026 });
    expect(run.body.payslips).toBe(1);

    const detail = await get(`/api/v1/payroll-runs/${run.body.runId}`);
    expect(Number(detail.body.payslips[0].gross)).toBe(60000); // 50000 + 10000
    expect(Number(detail.body.payslips[0].netPay)).toBe(60000); // no deductions

    const approve = await post(`/api/v1/payroll-runs/${run.body.runId}/approve`);
    expect(approve.body.status).toBe('APPROVED');

    // Payslip PDF: rendered, uploaded to storage, served via a presigned GET (§13/§15).
    const payslipId = detail.body.payslips[0].id;
    const pdf = await get(`/api/v1/payslips/${payslipId}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.body.url).toContain('http');
    const fetched = await fetch(pdf.body.url);
    expect(fetched.status).toBe(200);
    const buf = Buffer.from(await fetched.arrayBuffer());
    expect(buf.subarray(0, 4).toString()).toBe('%PDF'); // real PDF bytes over MinIO
  });

  it('issues certificates (fee clearance passes with no invoices)', async () => {
    const char = await post('/api/v1/documents/certificates', { studentId, type: 'CHARACTER_CERT' });
    expect(char.status).toBe(201);
    const leaving = await post('/api/v1/documents/certificates', { studentId, type: 'LEAVING_CERT' });
    expect(leaving.status).toBe(201);

    const docs = await get(`/api/v1/documents?studentId=${studentId}`);
    expect(docs.body.length).toBe(2);
  });

  it('serves the dashboard and the audit-log browser', async () => {
    const dash = await get('/api/v1/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.body).toHaveProperty('enrollmentCount');

    const audit = await get('/api/v1/audit-logs');
    expect(audit.status).toBe(200);
    expect(Array.isArray(audit.body.data)).toBe(true);
  });
});
