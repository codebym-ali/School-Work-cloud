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

/**
 * Tenant-isolation SWEEP (QA plan C2). `tenant-isolation.spec` proves the MECHANISM fails closed (no
 * tenant context / no set_config → zero rows). This proves APPLICATION COVERAGE: two fully-seeded schools
 * with identical-looking data, then across the crown-jewel endpoints —
 *   (a) every list returns ONLY the caller's own rows, never the other school's;
 *   (b) every cross-tenant `GET /:id` with the OTHER school's id → 404 (never 200, never 403 — a 403 would
 *       confirm the row exists, leaking its existence across the tenant boundary).
 * A regression that drops a `where school_id` (or reads outside `withTenant`) turns this red.
 */
interface Seeded {
  schoolId: string;
  host: string;
  cookies: string[];
  csrf: string;
  campusId: string;
  yearId: string;
  classId: string;
  sectionId: string;
  subjectId: string;
  staffId: string;
  studentId: string;
  enrollmentId: string;
  termId: string;
  examId: string;
  invoiceId: string;
  paymentId: string;
}

describe('Tenant-isolation sweep — two schools, crown-jewel endpoints (e2e, §2/§22)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let A: Seeded;
  let B: Seeded;

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);

  async function seedSchool(tag: string): Promise<Seeded> {
    const sub = `iso-${tag}-${randomUUID().slice(0, 6)}`;
    const host = `${sub}.localhost`;
    const email = `owner@${tag}.pk`;
    const password = 'Owner!Secret12';
    const prov = await app
      .get(ProvisioningService, { strict: false })
      .provisionSchool({ name: `Iso ${tag}`, subdomain: sub, ownerEmail: email, ownerPassword: password });
    const cookies = (await loginRequest(server(), host, email, password)).headers['set-cookie'] as unknown as string[];
    const csrf = csrfOf(cookies);
    const post = (p: string, body: object = {}, headers: Record<string, string> = {}) => {
      let r = request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf);
      for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
      return r.send(body);
    };
    const get = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

    const yearId = (await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true })).body.id;
    const classId = (await post('/api/v1/classes', { campusId: prov.campusId, name: 'Grade 1', order: 1 })).body.id;
    const sectionId = (await post('/api/v1/sections', { classId, name: 'A' })).body.id;
    const subjectId = (await post('/api/v1/subjects', { classId, name: 'Math' })).body.id;
    const staffId = (await post('/api/v1/staff', {
      email: `teacher@${tag}.pk`, campusId: prov.campusId, staffType: 'TEACHER',
      employeeCode: `EMP-${randomUUID().slice(0, 6)}`, designation: 'Teacher', joinedAt: '2026-04-01', fullName: `T ${tag}`,
    })).body.staffId;

    const { admit } = await admissionController(app, platform, prov.schoolId, host, prov.campusId);
    const student = await admit({
      fullName: `Child ${tag}`, gender: 'FEMALE', dateOfBirth: '2020-05-10', campusId: prov.campusId, classId, sectionId,
      guardian: { mode: 'CREATE', fullName: `Guardian ${tag}`, phone: '03007654321', relation: 'FATHER' },
    });

    const termId = (await post('/api/v1/terms', { academicYearId: yearId, name: 'Term 1', startDate: '2026-04-01', endDate: '2026-09-30' })).body.id;
    const examId = (await post('/api/v1/exams', { termId, classId, name: 'Mid', examType: 'MID_TERM', weightagePercent: 100, examDate: '2026-07-01' })).body.id;

    // A real invoice + a real payment → financial cross-tenant checks are non-vacuous.
    const head = await post('/api/v1/fee-heads', { name: 'Tuition' });
    await post('/api/v1/fee-structures', { campusId: prov.campusId, classId, feeHeadId: head.body.id, academicYearId: yearId, amount: 1000, frequency: 'MONTHLY' });
    await post('/api/v1/fees/invoice-batches', { classId, month: 7, year: 2026 });
    const invoiceId = (await get(`/api/v1/fees/invoices?studentId=${student.body.studentId}&month=7&year=2026`)).body.data[0].id;
    const paymentId = (await post(`/api/v1/fees/invoices/${invoiceId}/payments`, { amountPaid: 100, method: 'CASH' }, { 'Idempotency-Key': randomUUID() })).body.paymentId;

    return {
      schoolId: prov.schoolId, host, cookies, csrf, campusId: prov.campusId, yearId, classId, sectionId, subjectId,
      staffId, studentId: student.body.studentId, enrollmentId: student.body.enrollmentId, termId, examId, invoiceId, paymentId,
    };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    platform = app.get(PlatformPrismaService);
    A = await seedSchool('a');
    B = await seedSchool('b');
  }, 120_000);

  afterAll(async () => {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    if (A) await destroyTenant(platform, A.schoolId);
    if (B) await destroyTenant(platform, B.schoolId);
    await app.close();
  });

  // School A's owner session throughout: it must never see B.
  const getA = (p: string) => request(server()).get(p).set('Host', A.host).set('Cookie', A.cookies);
  const rowsOf = (body: unknown): Array<{ id?: string }> => {
    const b = body as { data?: unknown };
    return (Array.isArray(b?.data) ? b.data : Array.isArray(body) ? body : []) as Array<{ id?: string }>;
  };
  const ids = (body: unknown) => rowsOf(body).map((r) => r.id);

  describe('(a) list endpoints return only the caller’s own rows', () => {
    const cases: Array<{ label: string; path: () => string; mine: () => string; theirs: () => string }> = [
      { label: 'students', path: () => '/api/v1/students', mine: () => A.studentId, theirs: () => B.studentId },
      { label: 'staff', path: () => '/api/v1/staff', mine: () => A.staffId, theirs: () => B.staffId },
      { label: 'classes', path: () => '/api/v1/classes', mine: () => A.classId, theirs: () => B.classId },
      { label: 'sections', path: () => `/api/v1/sections?classId=${A.classId}`, mine: () => A.sectionId, theirs: () => B.sectionId },
      { label: 'subjects', path: () => `/api/v1/subjects?classId=${A.classId}`, mine: () => A.subjectId, theirs: () => B.subjectId },
      { label: 'campuses', path: () => '/api/v1/campuses', mine: () => A.campusId, theirs: () => B.campusId },
      { label: 'academic-years', path: () => '/api/v1/academic-years', mine: () => A.yearId, theirs: () => B.yearId },
      { label: 'enrollments', path: () => '/api/v1/enrollments', mine: () => A.enrollmentId, theirs: () => B.enrollmentId },
      { label: 'exams', path: () => '/api/v1/exams', mine: () => A.examId, theirs: () => B.examId },
    ];
    for (const c of cases) {
      it(`${c.label}: sees own, never the other school’s`, async () => {
        const res = await getA(c.path());
        expect(res.status).toBe(200);
        const seen = ids(res.body);
        expect(seen).toContain(c.mine());
        expect(seen).not.toContain(c.theirs());
      });
    }

    it('invoices filtered by the OTHER school’s student id return nothing', async () => {
      const res = await getA(`/api/v1/fees/invoices?studentId=${B.studentId}&month=7&year=2026`);
      expect(res.status).toBe(200);
      expect(ids(res.body)).not.toContain(B.invoiceId);
    });
  });

  describe('(b) cross-tenant GET /:id → 404 (never 200, never 403)', () => {
    const cases: Array<{ label: string; path: () => string }> = [
      { label: 'a student', path: () => `/api/v1/students/${B.studentId}` },
      // (GET /students/:id/cnic is @RequiresMfa — a 403 there is the MFA gate, not an isolation signal, so
      //  student-data isolation is proven by /students/:id above, not by the MFA-gated reveal.)
      { label: 'a staff member', path: () => `/api/v1/staff/${B.staffId}` },
      { label: 'an invoice', path: () => `/api/v1/fees/invoices/${B.invoiceId}` },
      { label: 'a payment receipt', path: () => `/api/v1/fees/payments/${B.paymentId}/receipt` },
      { label: 'exam results', path: () => `/api/v1/exams/${B.examId}/results` },
    ];
    for (const c of cases) {
      it(`${c.label} in the other school → 404`, async () => {
        const res = await getA(c.path());
        expect(res.status).toBe(404);
      });
    }
  });
});
