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

/**
 * M5 gate (roadmap M5): enter/publish marks + parent views report card.
 * define exams → marks (partial-failure) → publish completeness gate →
 * generate report cards (term result + dense rank + grade) → read as "parent".
 */
describe('Exams & report cards (e2e, §11)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let cls: ClsService;
  let tenantPrisma: TenantPrismaService;
  let sms: SmsService;
  let schoolId: string;
  let cookies: string[];
  let csrf: string;
  let yearId: string;
  let classId: string;
  let termId: string;
  let examId: string;
  let studentId: string;
  let enrollmentId: string;
  let mathId: string;
  let englishId: string;

  const sub = `exm-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const email = 'owner@exm.pk';
  const password = 'Owner!Secret12';

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object = {}) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).send(b);
  const put = (p: string, b: object) =>
    request(server()).put(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).send(b);
  const get = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

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

    const prov = await app.get(ProvisioningService, { strict: false }).provisionSchool({ name: 'Exam School', subdomain: sub, ownerEmail: email, ownerPassword: password });
    schoolId = prov.schoolId;
    const login = await request(server()).post('/api/v1/auth/login').set('Host', host).send({ email, password });
    cookies = login.headers['set-cookie'] as unknown as string[];
    csrf = csrfOf(cookies);

    yearId = (await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true })).body.id;
    classId = (await post('/api/v1/classes', { campusId: prov.campusId, name: 'Grade 1', order: 1 })).body.id;
    const section = await post('/api/v1/sections', { classId, name: 'A' });
    mathId = (await post('/api/v1/subjects', { classId, name: 'Math' })).body.id;
    englishId = (await post('/api/v1/subjects', { classId, name: 'English' })).body.id;
    const { admit } = await admissionController(app, platform, schoolId, host);
    const student = await admit({
      fullName: 'Sara Khan', gender: 'FEMALE', dateOfBirth: '2020-05-10', campusId: prov.campusId, classId, sectionId: section.body.id,
      guardian: { mode: 'CREATE', fullName: 'Ali Khan', phone: '03007654321', relation: 'FATHER' },
    });
    studentId = student.body.studentId;
    enrollmentId = student.body.enrollmentId;
    await platform.parentProfile.updateMany({ where: { schoolId }, data: { phoneVerifiedAt: new Date() } });

    await put('/api/v1/grade-scales', {
      academicYearId: yearId,
      bands: [
        { label: 'A+', minPercent: 90, maxPercent: 100, gradePoint: 4 },
        { label: 'A', minPercent: 80, maxPercent: 89.99, gradePoint: 3.7 },
        { label: 'B', minPercent: 70, maxPercent: 79.99, gradePoint: 3 },
        { label: 'F', minPercent: 0, maxPercent: 69.99, gradePoint: 0 },
      ],
    });
    termId = (await post('/api/v1/terms', { academicYearId: yearId, name: 'Term 1', startDate: '2026-04-01', endDate: '2026-09-30' })).body.id;
  });

  afterAll(async () => {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    const tables = [
      'auditLog', 'reportCard', 'document', 'examResult', 'examDefinition', 'term', 'gradeScale',
      'smsLog', 'smsCreditLedger', 'smsTemplate', 'studentGuardian', 'studentEnrollment', 'student',
      'inquiry', 'parentProfile', 'refreshToken', 'user', 'subject', 'section', 'class', 'academicYear', 'campus', 'school',
    ] as const;
    for (const t of tables) {
      const d = platform[t] as unknown as { deleteMany: (a: unknown) => Promise<unknown> };
      await d.deleteMany({ where: t === 'school' ? { id: schoolId } : { schoolId } }).catch(() => undefined);
    }
    await app.close();
  });

  it('defines an exam (weightage 100) and opens marks entry', async () => {
    const exam = await post('/api/v1/exams', { termId, classId, name: 'Mid-Term', examType: 'MID_TERM', weightagePercent: 100, examDate: '2026-07-01' });
    expect(exam.status).toBe(201);
    examId = exam.body.id;
    const open = await post(`/api/v1/exams/${examId}/open-marks-entry`);
    expect(open.body.status).toBe('MARKS_ENTRY');
  });

  it('enters marks with per-row validation (marks > total fails, others succeed)', async () => {
    const res = await post(`/api/v1/exams/${examId}/results/bulk`, {
      records: [
        { enrollmentId, subjectId: mathId, totalMarks: 100, marksObtained: 80 },
        { enrollmentId, subjectId: englishId, totalMarks: 100, marksObtained: 150 }, // invalid
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ succeeded: 1, failed: 1 });
  });

  it('blocks publish until every (student × subject) has a mark (RESULTS_INCOMPLETE)', async () => {
    const early = await post(`/api/v1/exams/${examId}/publish`);
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('RESULTS_INCOMPLETE');

    const fix = await post(`/api/v1/exams/${examId}/results/bulk`, {
      records: [{ enrollmentId, subjectId: englishId, totalMarks: 100, marksObtained: 90 }],
    });
    expect(fix.body.succeeded).toBe(1);

    const publish = await post(`/api/v1/exams/${examId}/publish`);
    expect(publish.body.status).toBe('PUBLISHED');
  });

  it('generates report cards: overall = mean, grade from scale, section rank', async () => {
    const gen = await post(`/api/v1/terms/${termId}/report-cards/generate`);
    expect(gen.body.generated).toBe(1);

    const cards = await get(`/api/v1/terms/${termId}/report-cards`);
    expect(cards.body).toHaveLength(1);
    expect(Number(cards.body[0].overallPercent)).toBe(85); // mean(80, 90)
    expect(cards.body[0].gradeLabel).toBe('A');
    expect(cards.body[0].sectionRank).toBe(1);
  });

  it('serves the report card on the student (parent view) and sends result SMS', async () => {
    const byStudent = await get(`/api/v1/students/${studentId}/report-cards`);
    expect(byStudent.body).toHaveLength(1);
    expect(Number(byStudent.body[0].overallPercent)).toBe(85);

    await drainSms();
    const results = await platform.smsLog.findMany({ where: { schoolId, templateKey: 'RESULT_READY' } });
    expect(results.length).toBe(1);
    expect(results[0].status).toBe('SENT');
  });

  it('refuses to delete a term that carries academic records, but removes an unused one', async () => {
    const del = (p: string) =>
      request(server()).delete(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf);

    // `termId` now has an exam + published report cards — deleting it would destroy results.
    const blocked = await del(`/api/v1/terms/${termId}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('CONFLICT');
    expect(blocked.body.error.message).toMatch(/report card/i);
    expect((await get('/api/v1/terms')).body.some((t: { id: string }) => t.id === termId)).toBe(true);

    // A term created by mistake (no exams, no report cards) can be removed.
    const spare = await post('/api/v1/terms', { academicYearId: yearId, name: 'Typo Term', startDate: '2026-10-01', endDate: '2026-10-31' });
    expect(spare.status).toBe(201);
    expect((await del(`/api/v1/terms/${spare.body.id}`)).status).toBe(200);
    expect((await get('/api/v1/terms')).body.some((t: { id: string }) => t.id === spare.body.id)).toBe(false);
  });
});
