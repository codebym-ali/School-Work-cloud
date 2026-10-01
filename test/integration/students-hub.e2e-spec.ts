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
import { loginRequest } from './support/login';
import { opsAdminSession } from './support/ops-admin';

/**
 * The owner's Students hub (Owner UX Phase 1b). The contract that matters: every KPI tile opens onto
 * exactly the students it counts, a header sort covers the WHOLE list (not the page in hand), and each
 * row carries enough to read "Ahmed · s/o Tariq · Grade 6 — A" without client-side joins.
 */
describe('Students hub (e2e, Owner UX 1b)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let ops: Awaited<ReturnType<typeof opsAdminSession>>;
  let classId: string;
  let sectionA: string;
  let sectionB: string;
  let subjectId: string;
  const enrolments: Record<string, string> = {};

  const sub = `hub-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@hub.pk', password: 'Owner!Secret12' };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send(b);
  const get = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const provisioning = app.get(ProvisioningService, { strict: false });
    const prov = await provisioning.provisionSchool({ name: 'Hub School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;
    const campusId = prov.campusId;
    cookies = (await loginRequest(server(), host, owner.email, owner.password)).headers['set-cookie'] as unknown as string[];
    ops = await opsAdminSession(app, platform, schoolId, host, 'ops@hub.pk', campusId);
    const opsPost = (p: string, b: object) => ops.post(p, b);

    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    classId = (await opsPost('/api/v1/classes', { campusId, name: 'Grade 6', order: 6 })).body.id;
    sectionA = (await opsPost('/api/v1/sections', { classId, name: 'A' })).body.id;
    sectionB = (await opsPost('/api/v1/sections', { classId, name: 'B' })).body.id;
    subjectId = (await opsPost('/api/v1/subjects', { classId, name: 'Maths' })).body.id;

    const { admit } = await admissionController(app, platform, schoolId, host, campusId);
    // Three in A (two with a father), one in B with no guardian at all.
    const people: Array<[string, 'MALE' | 'FEMALE', string, string | null]> = [
      ['Ahmed Butt', 'MALE', sectionA, 'Tariq Butt'],
      ['Sana Butt', 'FEMALE', sectionA, 'Tariq Butt'],
      ['Bilal Khan', 'MALE', sectionA, 'Kamran Khan'],
      ['Zara Ali', 'FEMALE', sectionB, null],
    ];
    for (const [i, [fullName, gender, sectionId, father]] of people.entries()) {
      const res = await admit({
        fullName, gender, dateOfBirth: '2014-01-01', campusId, classId, sectionId,
        ...(father ? { guardian: { mode: 'CREATE', fullName: father, phone: `0300555${String(i).padStart(4, '0')}`, relation: 'FATHER' } } : {}),
      });
      expect(res.status).toBe(201);
      enrolments[fullName] = res.body.enrollmentId;
    }
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('carries class-section, campus and parentage on every row', async () => {
    const res = await get('/api/v1/students?search=Ahmed');
    expect(res.status).toBe(200);
    const row = res.body.data[0];
    expect(row.enrollments[0]).toMatchObject({ class: { name: 'Grade 6' }, section: { name: 'A' } });
    expect(row.enrollments[0].campus.name).toBeTruthy();
    expect(row.primaryGuardian).toEqual({ fullName: 'Tariq Butt', relation: 'FATHER' });
    expect(row).toMatchObject({ todayStatus: null, attendancePercent: null, feeStatus: 'CLEAR', outstanding: 0 });
  });

  it('sorts the whole list on the server, continuing across pages', async () => {
    const p1 = await get('/api/v1/students?sort=name:desc&pageSize=2&page=1');
    const p2 = await get('/api/v1/students?sort=name:desc&pageSize=2&page=2');
    const names = [...p1.body.data, ...p2.body.data].map((s: { fullName: string }) => s.fullName);
    expect(names).toEqual(['Zara Ali', 'Sana Butt', 'Bilal Khan', 'Ahmed Butt']);
  });

  it('lets the owner set the display name the header shows (Owner UX Phase 2)', async () => {
    const patch = (fullName: string) =>
      request(server()).patch('/api/v1/auth/me/name').set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send({ fullName });
    expect((await get('/api/v1/auth/me')).body.name).toBeNull(); // an owner has no staff record to borrow a name from
    expect((await patch('  Muhammad   Ali ')).body).toEqual({ name: 'Muhammad Ali' });
    expect((await get('/api/v1/auth/me')).body.name).toBe('Muhammad Ali');
    expect((await patch('')).body).toEqual({ name: null }); // empty clears it
  });

  it('rejects a sort it does not know', async () => {
    expect((await get('/api/v1/students?sort=cnicHash:asc')).status).toBe(400);
  });

  it('summary counts agree with the filters each tile opens', async () => {
    const sum = (await get(`/api/v1/students/summary?classId=${classId}`)).body;
    expect(sum.active).toBe(4);
    expect(sum.missingGuardian).toBe(1);
    expect(sum.newThisMonth).toBe(4); // admitted today
    const total = (q: string) => get(`/api/v1/students?classId=${classId}&status=ACTIVE&${q}`).then((r) => r.body.total);
    expect(await total('missingGuardian=true')).toBe(sum.missingGuardian);
    expect(await total('newThisMonth=true')).toBe(sum.newThisMonth);
    expect(await total('feeDefaulter=true')).toBe(sum.feeDefaulters);
    // Nobody marked yet ⇒ on an open day every active child is unmarked, and none is present.
    if (sum.today.schoolDayOpen) {
      expect(sum.today.unmarked).toBe(4);
      expect(await total('today=UNMARKED')).toBe(4);
    }
    expect(sum.today.present).toBe(0);
    expect(sum.today.presentPercent).toBeNull();
  });

  it('narrows the summary to a section', async () => {
    const sum = (await get(`/api/v1/students/summary?classId=${classId}&sectionId=${sectionB}`)).body;
    expect(sum.active).toBe(1);
    expect(sum.missingGuardian).toBe(1);
  });

  it('narrows class performance to one section', async () => {
    const t = await ops.post('/api/v1/class-tests', { sectionId: sectionA, subjectId, name: 'Quiz', totalMarks: 10, testDate: new Date().toISOString().slice(0, 10) });
    await ops.post(`/api/v1/class-tests/${t.body.id}/scores`, { rows: [{ enrollmentId: enrolments['Ahmed Butt'], marksObtained: 8 }] });
    const all = (await get(`/api/v1/reports/performance/classes/${classId}?range=1m`)).body.students;
    const onlyB = (await get(`/api/v1/reports/performance/classes/${classId}?range=1m&sectionId=${sectionB}`)).body.students;
    expect(all).toHaveLength(4);
    expect(onlyB.map((s: { fullName: string }) => s.fullName)).toEqual(['Zara Ali']);
    // …and the directory row picks the average up.
    const ahmed = (await get('/api/v1/students?search=Ahmed')).body.data[0];
    expect(ahmed.performancePercent).toBe(80);
  });
});
