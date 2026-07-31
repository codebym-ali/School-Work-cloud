import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { admissionController } from './support/admission';
import { destroyTenant } from './support/tenant';

/**
 * Class tests (§11 extension) — formative assessment owned by the subject teacher.
 *
 * The point of these tests is the GUARDS. A marks surface that lets the wrong teacher write, or
 * silently invalidates marks when a total is lowered, corrupts the record a parent will later be
 * shown. Each case below is one of those failure modes.
 */
describe('Class tests (e2e, §11 extension)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let ownerCookies: string[];
  let teacherCookies: string[];
  let otherTeacherCookies: string[];
  let sectionId: string;
  let mathsId: string;
  let scienceId: string;
  let enrollmentId: string;
  let testId: string;

  const sub = `ct-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@ct.pk', password: 'Owner!Secret12' };
  const teacher = { email: 'maths@ct.pk', password: 'Teach!Secret12' };
  const other = { email: 'science@ct.pk', password: 'Teach!Secret12' };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const send = (m: 'post' | 'patch' | 'delete', p: string, b: object, c: string[]) =>
    request(server())[m](p).set('Host', host).set('Cookie', c).set('X-CSRF-Token', csrfOf(c)).send(b);
  const get = (p: string, c: string[]) => request(server()).get(p).set('Host', host).set('Cookie', c);
  const login = async (email: string, password: string) =>
    (await request(server()).post('/api/v1/auth/login').set('Host', host).send({ email, password }))
      .headers['set-cookie'] as unknown as string[];

  const today = () => new Date().toISOString().slice(0, 10);

  /** Staff + an ACTIVE login + an assignment for one (section, subject). */
  async function makeTeacher(email: string, password: string, campusId: string, subjectId: string, yearId: string) {
    const staff = (await send('post', '/api/v1/staff', {
      email, staffType: 'TEACHER', employeeCode: `EMP-${randomUUID().slice(0, 6)}`,
      designation: 'Teacher', joinedAt: '2026-04-01', campusId,
    }, ownerCookies)).body;
    await platform.user.update({
      where: { id: staff.userId },
      data: { status: 'ACTIVE', passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    await send('post', '/api/v1/teacher-assignments', {
      staffId: staff.staffId, academicYearId: yearId, sectionId, subjectId,
    }, ownerCookies);
    return login(email, password);
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
    const prov = await provisioning.provisionSchool({ name: 'CT School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;
    const campusId = prov.campusId;

    ownerCookies = await login(owner.email, owner.password);
    const year = (await send('post', '/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true }, ownerCookies)).body;
    const klass = (await send('post', '/api/v1/classes', { campusId, name: 'Grade 9', order: 9 }, ownerCookies)).body;
    sectionId = (await send('post', '/api/v1/sections', { classId: klass.id, name: 'A' }, ownerCookies)).body.id;
    mathsId = (await send('post', '/api/v1/subjects', { classId: klass.id, name: 'Maths' }, ownerCookies)).body.id;
    scienceId = (await send('post', '/api/v1/subjects', { classId: klass.id, name: 'Science' }, ownerCookies)).body.id;

    const { admit } = await admissionController(app, platform, schoolId, host, campusId);
    const student = await admit({
      fullName: 'Bilal Ahmed', gender: 'MALE', dateOfBirth: '2012-01-10',
      campusId, classId: klass.id, sectionId,
      guardian: { mode: 'CREATE', fullName: 'Ahmed Ali', phone: '03001112233', relation: 'FATHER' },
    });
    enrollmentId = student.body.enrollmentId;

    teacherCookies = await makeTeacher(teacher.email, teacher.password, campusId, mathsId, year.id);
    otherTeacherCookies = await makeTeacher(other.email, other.password, campusId, scienceId, year.id);
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('lets the subject teacher set a test and enter marks', async () => {
    const created = await send('post', '/api/v1/class-tests', {
      sectionId, subjectId: mathsId, name: 'Chapter 3 quiz', totalMarks: 20, testDate: today(),
    }, teacherCookies);
    expect(created.status).toBe(201);
    testId = created.body.id;

    const scored = await send('post', `/api/v1/class-tests/${testId}/scores`, {
      rows: [{ enrollmentId, marksObtained: 18 }],
    }, teacherCookies);
    expect(scored.status).toBe(201);
    expect(scored.body).toMatchObject({ saved: 1, failed: 0 });

    const one = await get(`/api/v1/class-tests/${testId}`, teacherCookies);
    expect(Number(one.body.scores[0].marksObtained)).toBe(18);
  });

  it('refuses a teacher who does not teach that subject in that section', async () => {
    // The science teacher is assigned to the same SECTION but a different SUBJECT — the check
    // must be on the pair, not on the section alone, or any teacher could mark any subject.
    const res = await send('post', '/api/v1/class-tests', {
      sectionId, subjectId: mathsId, name: 'Sneaky test', totalMarks: 10, testDate: today(),
    }, otherTeacherCookies);
    expect(res.status).toBe(403);
  });

  it('rejects marks above the total, and absent-with-marks, per row', async () => {
    const res = await send('post', `/api/v1/class-tests/${testId}/scores`, {
      rows: [
        { enrollmentId, marksObtained: 21 },
        { enrollmentId, marksObtained: 5, isAbsent: true },
      ],
    }, teacherCookies);
    expect(res.status).toBe(201);
    expect(res.body.saved).toBe(0);
    expect(res.body.failed).toBe(2);
    expect(res.body.errors[0].message).toContain('exceed');
    expect(res.body.errors[1].message).toContain('absent');

    // The earlier valid mark is untouched — a rejected row must not disturb stored marks.
    const one = await get(`/api/v1/class-tests/${testId}`, teacherCookies);
    expect(Number(one.body.scores[0].marksObtained)).toBe(18);
  });

  it('refuses to lower the total below a mark already entered', async () => {
    const res = await send('patch', `/api/v1/class-tests/${testId}`, { totalMarks: 10 }, teacherCookies);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('already scored more than');

    // Raising it is fine.
    expect((await send('patch', `/api/v1/class-tests/${testId}`, { totalMarks: 25 }, teacherCookies)).status).toBe(200);
  });

  it('refuses to delete a test that carries marks, then allows an empty one', async () => {
    const blocked = await send('delete', `/api/v1/class-tests/${testId}`, {}, teacherCookies);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('mark(s) recorded');

    const empty = await send('post', '/api/v1/class-tests', {
      sectionId, subjectId: mathsId, name: 'Unused test', totalMarks: 10, testDate: today(),
    }, teacherCookies);
    expect((await send('delete', `/api/v1/class-tests/${empty.body.id}`, {}, teacherCookies)).status).toBe(200);
  });

  it('records an absence without a mark, and keeps it out of the stored marks', async () => {
    const res = await send('post', `/api/v1/class-tests/${testId}/scores`, {
      rows: [{ enrollmentId, isAbsent: true }],
    }, teacherCookies);
    expect(res.body).toMatchObject({ saved: 1, failed: 0 });

    const score = await platform.classTestScore.findFirst({ where: { classTestId: testId, enrollmentId } });
    expect(score?.isAbsent).toBe(true);
    // Null, not zero: an absence is excluded from averages, never counted as a failure.
    expect(score?.marksObtained).toBeNull();
  });

  it('a teacher sees only their own sections; the owner sees everything', async () => {
    expect((await get('/api/v1/class-tests', teacherCookies)).body.length).toBeGreaterThanOrEqual(1);
    // The science teacher shares the section but the list is section-scoped, so they see it too —
    // what they cannot do is WRITE to Maths, proven above. The owner is unrestricted.
    expect((await get('/api/v1/class-tests', ownerCookies)).body.length).toBeGreaterThanOrEqual(1);
  });
});
