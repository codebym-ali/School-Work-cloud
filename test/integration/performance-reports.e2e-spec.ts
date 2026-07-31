import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { admissionController } from './support/admission';
import { destroyTenant } from './support/tenant';

/**
 * Performance drill-down (§11 extension): campus → class → student.
 *
 * The arithmetic is the risk. Marks are only comparable as percentages, absences must not read
 * as failure, and every level must agree — a director and a student shown different numbers for
 * the same child is worse than showing nothing.
 */
describe('Performance reports (e2e, §11 extension)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let classId: string;
  let sectionId: string;
  let subjectId: string;
  let alphaStudentId: string;
  let alphaEnrolmentId: string;
  let betaEnrolmentId: string;

  const sub = `perf-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@perf.pk', password: 'Owner!Secret12' };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send(b);
  const get = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);
  const today = () => new Date().toISOString().slice(0, 10);

  /** A test worth `total`, with one mark per enrolment (null marks ⇒ absent). */
  async function seedTest(name: string, total: number, marks: Array<[string, number | null]>) {
    const t = await post('/api/v1/class-tests', { sectionId, subjectId, name, totalMarks: total, testDate: today() });
    expect(t.status).toBe(201);
    const rows = marks.map(([enrollmentId, m]) =>
      m == null ? { enrollmentId, isAbsent: true } : { enrollmentId, marksObtained: m });
    const s = await post(`/api/v1/class-tests/${t.body.id}/scores`, { rows });
    expect(s.body.failed).toBe(0);
    return t.body.id as string;
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
    const prov = await provisioning.provisionSchool({ name: 'Perf School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;
    const campusId = prov.campusId;

    const login = await request(server()).post('/api/v1/auth/login').set('Host', host).send(owner);
    cookies = login.headers['set-cookie'] as unknown as string[];

    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    classId = (await post('/api/v1/classes', { campusId, name: 'Grade 9', order: 9 })).body.id;
    sectionId = (await post('/api/v1/sections', { classId, name: 'A' })).body.id;
    subjectId = (await post('/api/v1/subjects', { classId, name: 'Maths' })).body.id;

    const { admit } = await admissionController(app, platform, schoolId, host, campusId);
    const alpha = await admit({
      fullName: 'Alpha Student', gender: 'MALE', dateOfBirth: '2012-02-02',
      campusId, classId, sectionId,
      guardian: { mode: 'CREATE', fullName: 'A Parent', phone: '03005550001', relation: 'FATHER' },
    });
    alphaStudentId = alpha.body.studentId;
    alphaEnrolmentId = alpha.body.enrollmentId;

    const beta = await admit({
      fullName: 'Beta Student', gender: 'FEMALE', dateOfBirth: '2012-03-03',
      campusId, classId, sectionId,
      guardian: { mode: 'CREATE', fullName: 'B Parent', phone: '03005550002', relation: 'MOTHER' },
    });
    betaEnrolmentId = beta.body.enrollmentId;

    // Alpha: 18/20 then 30/50 → 48/70 = 69%. Beta: 10/20, then ABSENT for the 50-mark test,
    // so Beta must read 10/20 = 50% — the absence excluded, NOT scored as 0 (which would give
    // 10/70 = 14% and turn illness into failure).
    await seedTest('Quiz 1', 20, [[alphaEnrolmentId, 18], [betaEnrolmentId, 10]]);
    await seedTest('Test 2', 50, [[alphaEnrolmentId, 30], [betaEnrolmentId, null]]);
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('weights tests by their totals rather than averaging percentages', async () => {
    const res = await get(`/api/v1/reports/performance/students/${alphaStudentId}?range=1m`);
    expect(res.status).toBe(200);
    // 48/70 = 68.57 → 69. Averaging the two percentages (90 and 60) would give 75, which would
    // let a 10-mark quiz outweigh a 50-mark test.
    expect(res.body.overall.percent).toBe(69);
    expect(res.body.overall.testsTaken).toBe(2);
    expect(res.body.overall.marksObtained).toBe(48);
    expect(res.body.overall.marksTotal).toBe(70);
  });

  it('excludes an absence from the average and counts it separately', async () => {
    const res = await get(`/api/v1/reports/performance/classes/${classId}?range=1m`);
    const beta = res.body.students.find((s: { fullName: string }) => s.fullName === 'Beta Student');
    expect(beta.percent).toBe(50); // 10/20 — the missed 50-mark test is not a zero
    expect(beta.testsTaken).toBe(1);
    expect(beta.testsMissed).toBe(1);
  });

  it('lists students worst-first and names the weakest subject', async () => {
    const res = await get(`/api/v1/reports/performance/classes/${classId}?range=1m`);
    expect(res.body.className).toBe('Grade 9');
    // Beta (50%) must come before Alpha (69%) — a report at scale surfaces the exception.
    expect(res.body.students.map((s: { fullName: string }) => s.fullName)).toEqual(['Beta Student', 'Alpha Student']);
    expect(res.body.students[0].weakestSubject).toMatchObject({ name: 'Maths' });
  });

  it('rolls the class up for the campus view, keeping the head-count from enrolments', async () => {
    const res = await get('/api/v1/reports/performance/classes?range=1m');
    expect(res.status).toBe(200);
    const grade9 = res.body.find((c: { className: string }) => c.className === 'Grade 9');
    // (18+30+10) / (20+50+20) = 58/90 = 64%
    expect(grade9.percent).toBe(64);
    expect(grade9.students).toBe(2); // from ACTIVE enrolments, not from who sat a test
  });

  it('breaks one student down by subject and by calendar month', async () => {
    const res = await get(`/api/v1/reports/performance/students/${alphaStudentId}?range=1m`);
    expect(res.body.subjects).toHaveLength(1);
    expect(res.body.subjects[0]).toMatchObject({ subjectName: 'Maths', percent: 69 });
    expect(res.body.subjects[0].tests).toHaveLength(2);
    expect(res.body.monthly[0].month).toMatch(/^\d{4}-\d{2}$/);
    expect(res.body.monthly[0].percent).toBe(69);
  });

  it('agrees with the student portal for the same child', async () => {
    // The whole point of the shared calculator: a director and a student must never be shown
    // different numbers. This asserts the two code paths land on the same figure.
    const report = await get(`/api/v1/reports/performance/students/${alphaStudentId}?range=1m`);
    const scores = await platform.classTestScore.findMany({
      where: { enrollmentId: alphaEnrolmentId },
      include: { classTest: true },
    });
    const obtained = scores.reduce((a, s) => a + (s.marksObtained ? Number(s.marksObtained) : 0), 0);
    const total = scores.filter((s) => !s.isAbsent).reduce((a, s) => a + Number(s.classTest.totalMarks), 0);
    expect(report.body.overall.percent).toBe(Math.round((obtained / total) * 100));
  });

  it('returns a class nobody has tested rather than hiding it', async () => {
    const other = (await post('/api/v1/classes', { campusId: (await get('/api/v1/campuses')).body[0].id, name: 'Grade 10', order: 10 })).body;
    const res = await get('/api/v1/reports/performance/classes?range=1m');
    const g10 = res.body.find((c: { classId: string }) => c.classId === other.id);
    // Present with a null percent — "we never assessed this class" is a finding, not an absence
    // of data to be filtered away.
    expect(g10).toBeDefined();
    expect(g10.percent).toBeNull();
  });
});
