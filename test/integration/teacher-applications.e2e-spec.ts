import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';

/**
 * Teacher applications (HR — Add Teacher form). Proves the full form persists and reads back
 * (nested details incl. an experience entry), validation rejects a bad nested payload, list +
 * campus scoping work, and a TEACHER is denied.
 */
describe('Teacher applications (e2e, HR)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let ownerCookies: string[];
  let campusAId: string;
  let campusBId: string;

  const sub = `tap-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@tap.pk', password: 'Owner!Secret12' };
  const campusAdmin = { email: 'ca@tap.pk', password: 'Campus!Secret12' };
  const teacher = { email: 'tch@tap.pk', password: 'Teacher!Secret12' };

  const server = () => app.getHttpServer();
  const login = async (email: string, password: string) => {
    const res = await request(server()).post('/api/v1/auth/login').set('Host', host).send({ email, password });
    return res.headers['set-cookie'] as unknown as string[];
  };
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object, cookies: string[]) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send(b);
  const patch = (p: string, b: object, cookies: string[]) =>
    request(server()).patch(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send(b);
  const get = (p: string, cookies: string[]) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

  const fullBody = (campusId: string) => ({
    campusId, fullName: 'Ayesha Khan', email: 'ayesha@ex.pk', mobile: '03001234567',
    positionAppliedFor: 'Physics Teacher', department: 'Science', employmentType: 'FULL_TIME',
    expectedSalary: 85000, availableJoiningDate: '2026-09-01',
    details: {
      fatherName: 'Khalid Khan', dateOfBirth: '1990-05-10', gender: 'FEMALE', cnic: '35202-1234567-8',
      currentAddress: 'House 1, Lahore', city: 'Lahore', highestQualification: 'M.Sc Physics',
      experiences: [{ schoolName: 'City School', position: 'Physics Teacher', duration: '2018-2024', reasonForLeaving: 'Growth' }],
      languages: 'Urdu, English',
    },
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const provisioning = app.get(ProvisioningService, { strict: false });
    const prov = await provisioning.provisionSchool({ name: 'TAP School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;
    campusAId = prov.campusId;

    ownerCookies = await login(owner.email, owner.password);
    campusBId = (await post('/api/v1/campuses', { name: 'Second Campus' }, ownerCookies)).body.id;
    await post('/api/v1/users', { email: campusAdmin.email, roles: ['CAMPUS_ADMIN'], campusId: campusAId, password: campusAdmin.password }, ownerCookies);
    await post('/api/v1/users', { email: teacher.email, roles: ['TEACHER'], campusId: campusAId, password: teacher.password }, ownerCookies);
  });

  afterAll(async () => {
    const tables = ['auditLog', 'teacherApplication', 'vacancy', 'staffProfile', 'refreshToken', 'user', 'campus', 'smsTemplate', 'smsCreditLedger', 'school'] as const;
    for (const t of tables) {
      const d = platform[t] as unknown as { deleteMany: (a: unknown) => Promise<unknown> };
      await d.deleteMany({ where: t === 'school' ? { id: schoolId } : { schoolId } }).catch(() => undefined);
    }
    await app.close();
  });

  it('creates a full application and reads back every section (incl. nested experience)', async () => {
    const created = await post('/api/v1/teacher-applications', fullBody(campusAId), ownerCookies);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ fullName: 'Ayesha Khan', status: 'SUBMITTED', campusName: 'Main Campus', employmentType: 'FULL_TIME' });
    const id = created.body.id;

    const detail = await get(`/api/v1/teacher-applications/${id}`, ownerCookies);
    expect(detail.status).toBe(200);
    expect(detail.body.details).toMatchObject({ cnic: '35202-1234567-8', fatherName: 'Khalid Khan', highestQualification: 'M.Sc Physics' });
    expect(detail.body.details.experiences[0]).toMatchObject({ schoolName: 'City School', reasonForLeaving: 'Growth' });
  });

  // Nested `details` validation must still bite. CNIC is optional now (a school hires
  // mid-term and chases the ID later), but a supplied one is still format-checked.
  it('rejects a bad nested payload (malformed details.cnic) → 400 VALIDATION_FAILED', async () => {
    const bad = fullBody(campusAId) as { details: Record<string, unknown> };
    bad.details.cnic = 'x'; // shorter than the @MinLength(5) on the nested DTO
    const res = await post('/api/v1/teacher-applications', bad, ownerCookies);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  // The "fill it in later" contract: a teacher can be recorded from the few fields the
  // office actually has on the day, without CNIC / DOB / address / city.
  it('accepts a partial profile (no cnic, dateOfBirth, currentAddress or city)', async () => {
    const partial = fullBody(campusAId) as { fullName: string; email: string; details: Record<string, unknown> };
    partial.fullName = 'Partial Profile Teacher';
    partial.email = `partial-${Date.now()}@demo.pk`;
    for (const k of ['cnic', 'dateOfBirth', 'currentAddress', 'city', 'fatherName', 'gender']) delete partial.details[k];
    const res = await post('/api/v1/teacher-applications', partial, ownerCookies);
    expect(res.status).toBe(201);
    expect(res.body.fullName).toBe('Partial Profile Teacher');
  });

  it('a campus admin only sees their own campus’s applications', async () => {
    await post('/api/v1/teacher-applications', { ...fullBody(campusBId), fullName: 'Campus B Person' }, ownerCookies);
    const caCookies = await login(campusAdmin.email, campusAdmin.password);
    const list = await get('/api/v1/teacher-applications', caCookies);
    expect(list.status).toBe(200);
    expect(list.body.every((a: { campusId: string }) => a.campusId === campusAId)).toBe(true);
  });

  it('denies a TEACHER (403)', async () => {
    const tCookies = await login(teacher.email, teacher.password);
    expect((await get('/api/v1/teacher-applications', tCookies)).status).toBe(403);
    expect((await post('/api/v1/teacher-applications', fullBody(campusAId), tCookies)).status).toBe(403);
  });

  it('pipeline: shortlist → hire creates a staff login → HIRED is terminal', async () => {
    const created = await post('/api/v1/teacher-applications', { ...fullBody(campusAId), email: 'hire.me@ex.pk' }, ownerCookies);
    const id = created.body.id;

    // SUBMITTED → SHORTLISTED
    const shortlisted = await patch(`/api/v1/teacher-applications/${id}/status`, { status: 'SHORTLISTED' }, ownerCookies);
    expect(shortlisted.status).toBe(200);
    expect(shortlisted.body.status).toBe('SHORTLISTED');

    // Hire → creates the staff User + StaffProfile and flips to HIRED
    const hired = await post(`/api/v1/teacher-applications/${id}/hire`, { employeeCode: `EMP-${randomUUID().slice(0, 6)}` }, ownerCookies);
    expect(hired.status).toBe(201);
    expect(hired.body.status).toBe('HIRED');
    expect(hired.body.staff).toMatchObject({ employeeCode: expect.any(String), userId: expect.any(String), staffId: expect.any(String) });

    // The hired teacher now shows up in the staff directory.
    const staff = await get('/api/v1/staff?staffType=TEACHER', ownerCookies);
    expect(staff.body.some((s: { user: { email: string } }) => s.user.email === 'hire.me@ex.pk')).toBe(true);

    // HIRED is terminal — no further status change or re-hire.
    expect((await patch(`/api/v1/teacher-applications/${id}/status`, { status: 'REJECTED' }, ownerCookies)).status).toBe(409);
    expect((await post(`/api/v1/teacher-applications/${id}/hire`, { employeeCode: 'EMP-DUP' }, ownerCookies)).status).toBe(409);
  });

  it('a rejected application can no longer be changed (409)', async () => {
    const created = await post('/api/v1/teacher-applications', { ...fullBody(campusAId), email: 'reject.me@ex.pk' }, ownerCookies);
    const id = created.body.id;
    expect((await patch(`/api/v1/teacher-applications/${id}/status`, { status: 'REJECTED', reason: 'Not a fit' }, ownerCookies)).status).toBe(200);
    expect((await patch(`/api/v1/teacher-applications/${id}/status`, { status: 'SHORTLISTED' }, ownerCookies)).status).toBe(409);
    expect((await post(`/api/v1/teacher-applications/${id}/hire`, { employeeCode: 'EMP-Z' }, ownerCookies)).status).toBe(409);
  });

  it('recruitment summary reflects the pipeline (campus-scoped)', async () => {
    const res = await get('/api/v1/vacancies/summary', ownerCookies);
    expect(res.status).toBe(200);
    expect(res.body.applicationsByStatus).toMatchObject({ SUBMITTED: expect.any(Number), HIRED: expect.any(Number) });
    expect(res.body.applicationsByStatus.HIRED).toBeGreaterThanOrEqual(1);
  });
});
