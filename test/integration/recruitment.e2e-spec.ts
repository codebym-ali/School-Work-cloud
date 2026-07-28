import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { destroyTenant } from './support/tenant';

/**
 * Recruitment — vacancies (HR module, first slice). Proves the vertical slice end-to-end:
 * post → validation reject → list → close → re-close 409, plus campus scoping and RBAC deny.
 */
describe('Recruitment / vacancies (e2e, HR)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let ownerCookies: string[];
  let campusAId: string;
  let campusBId: string;

  const sub = `rec-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@rec.pk', password: 'Owner!Secret12' };
  const campusAdmin = { email: 'ca@rec.pk', password: 'Campus!Secret12' };
  const teacher = { email: 'tch@rec.pk', password: 'Teacher!Secret12' };

  const server = () => app.getHttpServer();
  const login = async (email: string, password: string) => {
    const res = await request(server()).post('/api/v1/auth/login').set('Host', host).send({ email, password });
    return { status: res.status, cookies: res.headers['set-cookie'] as unknown as string[] };
  };
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object, cookies: string[]) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send(b);
  const get = (p: string, cookies: string[]) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

  const vacancyBody = (campusId: string) => ({
    campusId, title: 'Mathematics Teacher', department: 'Science',
    description: 'Teach O-level maths', employmentType: 'FULL_TIME', positions: 2,
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
    const prov = await provisioning.provisionSchool({ name: 'Rec School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;
    campusAId = prov.campusId;

    ownerCookies = (await login(owner.email, owner.password)).cookies;
    campusBId = (await post('/api/v1/campuses', { name: 'Second Campus' }, ownerCookies)).body.id;
    await post('/api/v1/users', { email: campusAdmin.email, roles: ['CAMPUS_ADMIN'], campusId: campusAId, password: campusAdmin.password }, ownerCookies);
    await post('/api/v1/users', { email: teacher.email, roles: ['TEACHER'], campusId: campusAId, password: teacher.password }, ownerCookies);
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('owner posts a vacancy (OPEN), rejects invalid input (422), lists it, then closes it', async () => {
    const created = await post('/api/v1/vacancies', vacancyBody(campusAId), ownerCookies);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: 'Mathematics Teacher', status: 'OPEN', positions: 2, campusName: 'Main Campus' });
    const id = created.body.id;

    // DTO validation (empty title, positions < 1) → 400 with the VALIDATION_FAILED envelope.
    const invalid = await post('/api/v1/vacancies', { ...vacancyBody(campusAId), title: '', positions: 0 }, ownerCookies);
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_FAILED');

    const list = await get('/api/v1/vacancies', ownerCookies);
    expect(list.status).toBe(200);
    expect(list.body.map((v: { id: string }) => v.id)).toContain(id);

    const closed = await post(`/api/v1/vacancies/${id}/close`, {}, ownerCookies);
    expect(closed.status).toBe(201);
    expect(closed.body.status).toBe('CLOSED');
    expect(closed.body.closedAt).toBeTruthy();

    // Re-closing an already-closed vacancy is an illegal transition.
    const reclose = await post(`/api/v1/vacancies/${id}/close`, {}, ownerCookies);
    expect(reclose.status).toBe(409);
    expect(reclose.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('a campus admin can post only for their own campus (cross-campus → 403), and sees only their campus', async () => {
    const caCookies = (await login(campusAdmin.email, campusAdmin.password)).cookies;

    const own = await post('/api/v1/vacancies', { ...vacancyBody(campusAId), title: 'Lab Assistant' }, caCookies);
    expect(own.status).toBe(201);

    const cross = await post('/api/v1/vacancies', { ...vacancyBody(campusBId), title: 'Sneaky' }, caCookies);
    expect(cross.status).toBe(403);

    // The list is force-scoped to campus A — the campus-B owner vacancy must not appear.
    await post('/api/v1/vacancies', { ...vacancyBody(campusBId), title: 'Campus B Role' }, ownerCookies);
    const caList = await get('/api/v1/vacancies', caCookies);
    expect(caList.body.every((v: { campusId: string }) => v.campusId === campusAId)).toBe(true);
  });

  it('denies a TEACHER (403) — no HR recruitment access', async () => {
    const tCookies = (await login(teacher.email, teacher.password)).cookies;
    expect((await get('/api/v1/vacancies', tCookies)).status).toBe(403);
    expect((await post('/api/v1/vacancies', vacancyBody(campusAId), tCookies)).status).toBe(403);
  });
});
