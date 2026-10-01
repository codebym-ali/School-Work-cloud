import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import type { Queue } from 'bullmq';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { SMS_QUEUE } from '../../apps/api/src/modules/comms/sms/sms.types';
import { admissionController } from './support/admission';
import { destroyTenant } from './support/tenant';
import { loginRequest } from './support/login';

/**
 * The student's term results: the list, and one term in full (every subject's marks, total, percent, grade).
 *
 * Four students share a section and score 90 / 80 / 70 / 60, so the dense ranks are 1 / 2 / 3 / 4. Three of them
 * have a portal login — rank 1, rank 3 (the edge of the podium) and rank 4 (just outside it).
 *
 * The rules pinned here are the ones a screen cannot be trusted to keep: a student is shown a rank ONLY on the
 * podium; the term is found through the caller's OWN report card (no id can reach another student's); an exam
 * a teacher is still entering is never shown; and there is no class average anywhere in the payload.
 */
describe('Student portal — term results (e2e)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let ownerCookies: string[];
  let termId: string;
  let emptyTermId: string;
  let classId: string;
  let yearId: string;
  let mathId: string;
  let englishId: string;
  const cookiesOf: Record<'first' | 'third' | 'fourth', string[]> = { first: [], third: [], fourth: [] };

  const sub = `spr-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@spr.pk', password: 'Owner!Secret12' };
  const pw = 'Student!Secret12';

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const ownerPost = (p: string, b: object = {}) =>
    request(server()).post(p).set('Host', host).set('Cookie', ownerCookies).set('X-CSRF-Token', csrfOf(ownerCookies)).send(b);
  const ownerPut = (p: string, b: object) =>
    request(server()).put(p).set('Host', host).set('Cookie', ownerCookies).set('X-CSRF-Token', csrfOf(ownerCookies)).send(b);
  const get = (p: string, cookies: string[]) => request(server()).get(p).set('Host', host).set('Cookie', cookies);
  const login = async (email: string, password: string) => (await loginRequest(server(), host, email, password)).headers['set-cookie'] as unknown as string[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const prov = await app.get(ProvisioningService, { strict: false }).provisionSchool({ name: 'SPR School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;
    ownerCookies = await login(owner.email, owner.password);

    yearId = (await ownerPost('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true })).body.id;
    classId = (await ownerPost('/api/v1/classes', { campusId: prov.campusId, name: 'Grade 1', order: 1 })).body.id;
    const section = await ownerPost('/api/v1/sections', { classId, name: 'A' });
    mathId = (await ownerPost('/api/v1/subjects', { classId, name: 'Math' })).body.id;
    englishId = (await ownerPost('/api/v1/subjects', { classId, name: 'English' })).body.id;
    await ownerPut('/api/v1/grade-scales', {
      academicYearId: yearId,
      bands: [
        { label: 'A+', minPercent: 90, maxPercent: 100, gradePoint: 4 },
        { label: 'A', minPercent: 80, maxPercent: 89.99, gradePoint: 3.7 },
        { label: 'B', minPercent: 70, maxPercent: 79.99, gradePoint: 3 },
        { label: 'F', minPercent: 0, maxPercent: 69.99, gradePoint: 0 },
      ],
    });
    termId = (await ownerPost('/api/v1/terms', { academicYearId: yearId, name: 'Term 1', startDate: '2026-04-01', endDate: '2026-09-30' })).body.id;
    emptyTermId = (await ownerPost('/api/v1/terms', { academicYearId: yearId, name: 'Term 2', startDate: '2026-10-01', endDate: '2027-03-31' })).body.id;

    const { admit } = await admissionController(app, platform, schoolId, host, prov.campusId);
    const scores = [90, 80, 70, 60];
    const enrollments: string[] = [];
    const studentIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const s = await admit({
        fullName: `Kid ${i + 1}`, gender: 'MALE', dateOfBirth: '2015-05-10', campusId: prov.campusId, classId, sectionId: section.body.id,
        guardian: { mode: 'CREATE', fullName: `Papa ${i + 1}`, phone: `0300765432${i + 1}`, relation: 'FATHER' },
      });
      enrollments.push(s.body.enrollmentId);
      studentIds.push(s.body.studentId);
    }

    const exam = await ownerPost('/api/v1/exams', { termId, classId, name: 'Mid-Term', examType: 'MID_TERM', weightagePercent: 100, examDate: '2026-07-01' });
    await ownerPost(`/api/v1/exams/${exam.body.id}/open-marks-entry`);
    await ownerPost(`/api/v1/exams/${exam.body.id}/results/bulk`, {
      records: enrollments.flatMap((enrollmentId, i) => [mathId, englishId].map((subjectId) => ({ enrollmentId, subjectId, totalMarks: 100, marksObtained: scores[i] }))),
    });
    await ownerPost(`/api/v1/exams/${exam.body.id}/publish`);
    await ownerPost(`/api/v1/terms/${termId}/report-cards/generate`);

    // A second exam a teacher is STILL entering: it must never reach a student.
    const draft = await ownerPost('/api/v1/exams', { termId, classId, name: 'Unpublished Quiz', examType: 'MONTHLY', weightagePercent: 10, examDate: '2026-08-01' });
    await ownerPost(`/api/v1/exams/${draft.body.id}/open-marks-entry`);
    await ownerPost(`/api/v1/exams/${draft.body.id}/results/bulk`, {
      records: [{ enrollmentId: enrollments[0], subjectId: mathId, totalMarks: 50, marksObtained: 1 }],
    });

    // Portal logins for rank 1, rank 3 and rank 4.
    const link = async (key: 'first' | 'third' | 'fourth', index: number, email: string) => {
      const user = await platform.user.create({
        data: { schoolId, email, passwordHash: await argon2.hash(pw, { type: argon2.argon2id }), roles: ['STUDENT'], status: 'ACTIVE' },
      });
      await platform.student.update({ where: { id: studentIds[index] }, data: { userId: user.id } });
      cookiesOf[key] = await login(email, pw);
    };
    await link('first', 0, 'one@spr.pk');
    await link('third', 2, 'three@spr.pk');
    await link('fourth', 3, 'four@spr.pk');
  });

  afterAll(async () => {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('shows a rank only for a podium finish (1st and 3rd yes, 4th no)', async () => {
    const first = await get('/api/v1/portal/results', cookiesOf.first);
    expect(first.status).toBe(200);
    expect(first.body[0]).toMatchObject({ termId, term: 'Term 1', overallPercent: 90, grade: 'A+', sectionRank: 1 });
    expect((await get('/api/v1/portal/results', cookiesOf.third)).body[0].sectionRank).toBe(3);
    expect((await get('/api/v1/portal/results', cookiesOf.fourth)).body[0].sectionRank).toBeNull();
  });

  it('gives the full term: every subject with marks, total, percent and grade, adding up to the card', async () => {
    const res = await get(`/api/v1/portal/results/${termId}`, cookiesOf.first);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ termId, term: 'Term 1', overallPercent: 90, grade: 'A+', rank: 1, totalObtained: 180, totalMarks: 200 });
    expect(res.body.subjects).toEqual([
      { subject: 'English', marksObtained: 90, totalMarks: 100, percent: 90, grade: 'A+', absent: false },
      { subject: 'Math', marksObtained: 90, totalMarks: 100, percent: 90, grade: 'A+', absent: false },
    ]);
    expect(res.body.exams).toHaveLength(1);
    expect(res.body.exams[0]).toMatchObject({ name: 'Mid-Term', weightagePercent: 100, obtained: 180, total: 200, percent: 90 });
    // The school's own bands come with it, so "A+" can be explained on screen.
    expect(res.body.gradeScale.map((b: { label: string }) => b.label)).toEqual(['A+', 'A', 'B', 'F']);
  });

  it('hides the rank of a student outside the top three, and never sends a class average', async () => {
    const fourth = await get(`/api/v1/portal/results/${termId}`, cookiesOf.fourth);
    expect(fourth.status).toBe(200);
    expect(fourth.body).toMatchObject({ overallPercent: 60, grade: 'F', rank: null });
    const third = await get(`/api/v1/portal/results/${termId}`, cookiesOf.third);
    expect(third.body).toMatchObject({ overallPercent: 70, grade: 'B', rank: 3 });
    for (const body of [fourth.body, third.body]) expect(JSON.stringify(body).toLowerCase()).not.toContain('average');
  });

  it('never shows an exam that is not published yet', async () => {
    const res = await get(`/api/v1/portal/results/${termId}`, cookiesOf.first);
    expect(JSON.stringify(res.body)).not.toContain('Unpublished Quiz');
    expect(res.body.exams.map((e: { name: string }) => e.name)).toEqual(['Mid-Term']);
    expect(res.body.totalMarks).toBe(200); // the draft quiz's 50 marks are not folded in
  });

  it('finds a term only through the caller’s own report card — unknown or empty terms are 404', async () => {
    expect((await get(`/api/v1/portal/results/${randomUUID()}`, cookiesOf.first)).status).toBe(404);
    // A real term this student has no report card for.
    expect((await get(`/api/v1/portal/results/${emptyTermId}`, cookiesOf.first)).status).toBe(404);
    expect((await get(`/api/v1/portal/results/${emptyTermId}/file`, cookiesOf.first)).status).toBe(404);
    expect((await get('/api/v1/portal/results/not-a-uuid', cookiesOf.first)).status).toBe(400);
  });

  it('hands the student a link to their own report-card file', async () => {
    const res = await get(`/api/v1/portal/results/${termId}/file`, cookiesOf.first);
    expect(res.status).toBe(200);
    expect(typeof res.body.url).toBe('string');
  });

  it('is for students only — the owner is refused', async () => {
    expect((await get(`/api/v1/portal/results/${termId}`, ownerCookies)).status).toBe(403);
    expect((await get('/api/v1/portal/results', ownerCookies)).status).toBe(403);
  });
});
