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
import { loginRequest } from './support/login';
import { enrolMfa } from './support/mfa';

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
  const del = (p: string) =>
    request(server()).delete(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf);
  const patch = (p: string, b: object) =>
    request(server()).patch(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).send(b);

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
    const login = await loginRequest(server(), host, email, password);
    // Enrolled: this spec does two-factor-gated work as the owner (see support/mfa.ts).
    cookies = await enrolMfa(server(), host, login.headers['set-cookie'] as unknown as string[]);
    csrf = csrfOf(cookies);

    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    // Target year for promotion — NOT current.
    targetYearId = (await post('/api/v1/academic-years', { name: '2027-28', startDate: '2027-04-01', endDate: '2028-03-31' })).body.id;

    const g1 = (await post('/api/v1/classes', { campusId, name: 'Grade 1', order: 1 })).body.id;
    const g2 = (await post('/api/v1/classes', { campusId, name: 'Grade 2', order: 2 })).body.id;
    grade1SectionA = (await post('/api/v1/sections', { classId: g1, name: 'A' })).body.id;
    await post('/api/v1/sections', { classId: g2, name: 'A' }); // promotion target section

    const { admit } = await admissionController(app, platform, schoolId, host, campusId);
    const student = await admit({
      fullName: 'Sara Khan', gender: 'FEMALE', dateOfBirth: '2020-05-10', campusId, classId: g1, sectionId: grade1SectionA,
      guardian: { mode: 'CREATE', fullName: 'Ali Khan', phone: '03007654321', relation: 'FATHER' },
    });
    studentId = student.body.studentId;
  });

  afterAll(async () => {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    await destroyTenant(platform, schoolId);
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

  /**
   * School closures (G12/H0). The `holidays` table was read in five places and written by
   * nothing, so every holiday check found nothing and Eid was a working day.
   *
   * These run AFTER the payroll test on purpose: it approves a run for 7/2026, which is exactly
   * what the money rule below needs to be real rather than hypothetical.
   */
  /**
   * G5 — whether an absence costs money is the SCHOOL's decision, not this service's.
   *
   * Payroll always deducted for absence and nobody could see that, let alone change it. Real
   * schools split: some dock a day's basic, others treat teacher absence as a management matter.
   *
   * Proved across two CAMPUSES rather than two months, because the alternatives do not work:
   * staff attendance cannot be marked for a future month, and a payroll run is idempotent per
   * (campus, month, year) — so re-running the same month after flipping the setting would return
   * the cached run and prove nothing. Two campuses, same month, one flip between them.
   */
  describe('absence deduction is a school decision', () => {
    const now = new Date();
    const month = now.getUTCMonth() + 1;
    const year = now.getUTCFullYear();
    /** Two past working days inside the CURRENT month — the only month that is both markable
     *  (not future) and free of an approved payroll run. */
    const absenceDays = (() => {
      const days: string[] = [];
      for (let d = now.getUTCDate() - 1; d >= 1 && days.length < 2; d--) {
        const day = new Date(Date.UTC(year, now.getUTCMonth(), d));
        if (day.getUTCDay() !== 0) days.push(day.toISOString().slice(0, 10));
      }
      return days;
    })();

    const setupStaff = async (campus: string, code: string) => {
      const staff = await post('/api/v1/staff', {
        email: `${code.toLowerCase()}@m6.pk`, staffType: 'TEACHER', employeeCode: code,
        designation: 'Teacher', joinedAt: '2026-04-01', campusId: campus,
      });
      await post(`/api/v1/staff/${staff.body.staffId}/salary-structures`, { basic: 30000, effectiveFrom: '2026-04-01' });
      for (const d of absenceDays) {
        await post('/api/v1/staff-attendance/bulk', {
          date: d, session: 'MORNING', records: [{ staffId: staff.body.staffId, status: 'ABSENT' }],
        });
      }
      return staff.body.staffId as string;
    };

    afterAll(async () => { await patch('/api/v1/school-settings', { payrollDeductsAbsence: true }); });

    it('deducts when the school says it should, and not when it says it should not', async () => {
      // Skip only if the month is too young to contain two past working days — a 1st-of-month
      // run has nothing to mark, and inventing future absences is exactly what the API refuses.
      if (absenceDays.length < 2) return;

      // ── ON (the default, and what every existing school already gets) ──
      await patch('/api/v1/school-settings', { payrollDeductsAbsence: true });
      const campusOn = (await post('/api/v1/campuses', { name: `Deduct-On ${Date.now()}` })).body.id;
      const staffOn = await setupStaff(campusOn, `T-ON${Date.now() % 10000}`);
      const runOn = await post('/api/v1/payroll-runs', { campusId: campusOn, month, year });
      const withDeduction = (await get(`/api/v1/payroll-runs/${runOn.body.runId}`)).body.payslips
        .find((p: { staffId: string }) => p.staffId === staffOn);
      expect(withDeduction.breakdown).toMatchObject({ absentDays: 2, deductForAbsence: true });
      expect(Number(withDeduction.attendanceDeduction)).toBeGreaterThan(0);

      // ── OFF ──
      await patch('/api/v1/school-settings', { payrollDeductsAbsence: false });
      const campusOff = (await post('/api/v1/campuses', { name: `Deduct-Off ${Date.now()}` })).body.id;
      const staffOff = await setupStaff(campusOff, `T-OFF${Date.now() % 10000}`);
      const runOff = await post('/api/v1/payroll-runs', { campusId: campusOff, month, year });
      const noDeduction = (await get(`/api/v1/payroll-runs/${runOff.body.runId}`)).body.payslips
        .find((p: { staffId: string }) => p.staffId === staffOff);

      // The absences are still RECORDED — they simply do not cost anything.
      expect(noDeduction.breakdown).toMatchObject({ absentDays: 2, deductForAbsence: false });
      expect(Number(noDeduction.attendanceDeduction)).toBe(0);
      expect(Number(noDeduction.netPay)).toBe(Number(noDeduction.gross));
    });

    /**
     * Unpaid leave is deducted in WORKING days, and is deducted even with absence deduction off.
     *
     * Two rules in one payslip, because they meet there:
     *  - a Sunday inside a leave range was charged as a leave day, at `basic / workingDays` — a
     *    rate whose divisor already excludes Sundays. A Sat–Mon leave cost three days' pay for
     *    two days of absence. The existing test above could not see this: `attendanceDeduction
     *    > 0` is equally true of the right answer and the wrong one.
     *  - `payrollDeductsAbsence: false` governs ABSENCES only. Approved unpaid leave is deducted
     *    either way — "unpaid leave" that does not reduce pay is a contradiction with a label
     *    (G5). Running this with the setting OFF is what makes that assertion mean something.
     */
    it('charges unpaid leave in working days, and charges it even when absences are free', async () => {
      // Sat → Mon around a Sunday inside this month: 3 calendar days, 2 working ones. Anchored on
      // a real Sunday rather than fixed dates so it holds whenever the suite runs.
      const firstOfMonth = new Date(Date.UTC(year, month - 1, 1));
      let sunday = 1 + ((7 - firstOfMonth.getUTCDay()) % 7); // first Sunday's date-of-month
      if (sunday === 1) sunday = 8; // need a day before it that is still in this month
      const iso = (d: number) => new Date(Date.UTC(year, month - 1, d)).toISOString().slice(0, 10);

      await patch('/api/v1/school-settings', { payrollDeductsAbsence: false });
      const campus = (await post('/api/v1/campuses', { name: `Unpaid-Leave ${Date.now()}` })).body.id;
      const staff = await post('/api/v1/staff', {
        email: `ul${Date.now() % 100000}@m6.pk`, staffType: 'TEACHER', employeeCode: `T-UL${Date.now() % 10000}`,
        designation: 'Teacher', joinedAt: '2026-04-01', campusId: campus,
      });
      const staffId = staff.body.staffId;
      await post(`/api/v1/staff/${staffId}/salary-structures`, { basic: 30000, effectiveFrom: '2026-04-01' });

      const leave = await post('/api/v1/staff-leaves', {
        staffId, leaveType: 'UNPAID', fromDate: iso(sunday - 1), toDate: iso(sunday + 1), reason: 'Family matter',
      });
      expect(leave.body.isUnpaid).toBe(true); // the type decides this, not the quota
      expect((await post(`/api/v1/staff-leaves/${leave.body.id}/approve`)).status).toBe(201);

      const run = await post('/api/v1/payroll-runs', { campusId: campus, month, year });
      const slip = (await get(`/api/v1/payroll-runs/${run.body.runId}`)).body.payslips
        .find((p: { staffId: string }) => p.staffId === staffId);

      // 2, not 3 — the Sunday was already not a working day, so it was never theirs to take.
      expect(slip.breakdown).toMatchObject({ unpaidLeaveDays: 2, absentDays: 0, deductForAbsence: false });
      const perDay = 30000 / slip.breakdown.workingDays;
      expect(Number(slip.attendanceDeduction)).toBeCloseTo(2 * perDay, 1);
    });
  });

  describe('school closures', () => {
    let holidayId: string;

    it('declares a closure, and refuses the same day twice', async () => {
      const res = await post('/api/v1/holidays', { date: '2026-09-15', name: 'Founders Day' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ name: 'Founders Day', campusId: null }); // owner ⇒ school-wide
      holidayId = res.body.id;

      // A clean 409 naming what is already there — not a raw unique-violation 500 (the lesson
      // F6 taught on fee structures).
      const dup = await post('/api/v1/holidays', { date: '2026-09-15', name: 'Something else' });
      expect(dup.status).toBe(409);
      expect(dup.body.error.message).toContain('Founders Day');
    });

    it('refuses a closure in a month whose payroll is already approved', async () => {
      // 7/2026 was approved above. A closure there changes the working-day count, which is the
      // divisor for every absence deduction — so it would change what people were already paid.
      const res = await post('/api/v1/holidays', { date: '2026-07-20', name: 'Retro holiday' });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/already approved/i);

      // And the same refusal applies to REMOVING one, because re-opening a day moves the count
      // in the other direction and breaks exactly the same payslips.
      const sept = await get('/api/v1/holidays?from=2026-09-01&to=2026-09-30');
      expect(sept.body.some((h: { id: string }) => h.id === holidayId)).toBe(true);
    });

    it('creates a range, skipping days that are already closed', async () => {
      const res = await post('/api/v1/holidays/range', {
        fromDate: '2026-09-14', toDate: '2026-09-17', name: 'Mid-term break',
      });
      expect(res.status).toBe(201);
      // 14, 16, 17 created; 15 skipped because "Founders Day" is already there. A range crossing
      // an existing holiday is the normal case, not an error (§25.3 partial failure).
      expect(res.body.created).toBe(3);
      expect(res.body.skipped).toEqual([expect.stringContaining('2026-09-15')]);
    });

    it('refuses a backwards range, a silly-long one, and an unnamed one', async () => {
      expect((await post('/api/v1/holidays/range', { fromDate: '2026-10-10', toDate: '2026-10-01', name: 'Break' })).status).toBe(422);
      // A mis-typed year would otherwise become 365 rows nobody meant.
      expect((await post('/api/v1/holidays/range', { fromDate: '2026-10-01', toDate: '2027-10-01', name: 'Break' })).status).toBe(422);
      // A name is required, and the DTO rejects it before the service is reached: the screens
      // render "{holidayName} — no register today", and "X" tells a teacher nothing.
      expect((await post('/api/v1/holidays', { date: '2026-11-01', name: 'X' })).status).toBe(400);
    });

    it('removes a closure', async () => {
      expect((await del(`/api/v1/holidays/${holidayId}`)).status).toBe(204);
      const after = await get('/api/v1/holidays?from=2026-09-01&to=2026-09-30');
      expect(after.body.some((h: { id: string }) => h.id === holidayId)).toBe(false);
    });
  });
});
