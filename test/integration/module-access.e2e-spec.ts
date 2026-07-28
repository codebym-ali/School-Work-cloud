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
 * Module (functionality) access (§23 extension). A granted role unlocks all of its modules by
 * default; the owner can switch a single module off for one user, taking effect immediately
 * (live in-service check, no re-login). Owners are never restricted. Proves: default-on,
 * owner switches recruitment.vacancies off → that user is 403 on the gated action but reads
 * still work, re-enable restores it, a non-owner can't manage modules, and a module outside
 * the user's roles can't be toggled.
 */
describe('Module access (e2e, §23)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let ownerCookies: string[];
  let campusAId: string;
  let teacherUserId: string;

  const sub = `mod-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@mod.pk', password: 'Owner!Secret12' };
  const teacher = { email: 'tch@mod.pk', password: 'Teacher!Secret12' };

  const server = () => app.getHttpServer();
  const login = async (email: string, password: string) =>
    (await request(server()).post('/api/v1/auth/login').set('Host', host).send({ email, password })).headers['set-cookie'] as unknown as string[];
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const send = (method: 'post' | 'patch', p: string, b: object, cookies: string[]) =>
    request(server())[method](p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).set('Idempotency-Key', randomUUID()).send(b);
  const get = (p: string, cookies: string[]) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

  const vacancyBody = () => ({ campusId: campusAId, title: 'Maths Teacher', department: 'Science', description: 'Teach maths', employmentType: 'FULL_TIME', positions: 1 });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const provisioning = app.get(ProvisioningService, { strict: false });
    const prov = await provisioning.provisionSchool({ name: 'Mod School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;
    campusAId = prov.campusId;

    ownerCookies = await login(owner.email, owner.password);
    const t = await send('post', '/api/v1/users', { email: teacher.email, roles: ['TEACHER'], campusId: campusAId, password: teacher.password }, ownerCookies);
    teacherUserId = t.body.id;
    await send('patch', `/api/v1/users/${teacherUserId}/access`, { role: 'HR_MANAGER', grant: true }, ownerCookies);
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('lists the HR modules for the user, all on by default', async () => {
    const res = await get(`/api/v1/users/${teacherUserId}/modules`, ownerCookies);
    expect(res.status).toBe(200);
    const keys = (res.body as Array<{ key: string; allowed: boolean }>);
    expect(keys.map((m) => m.key)).toEqual(expect.arrayContaining(['recruitment.vacancies', 'recruitment.applications', 'recruitment.hire']));
    expect(keys.every((m) => m.allowed)).toBe(true);
  });

  it('owner switches recruitment.vacancies off → the HR user is 403 on the gated action (immediately), reads still work', async () => {
    const hr = await login(teacher.email, teacher.password);
    expect((await send('post', '/api/v1/vacancies', vacancyBody(), hr)).status).toBe(201);

    const off = await send('patch', `/api/v1/users/${teacherUserId}/modules`, { moduleKey: 'recruitment.vacancies', allowed: false }, ownerCookies);
    expect(off.status).toBe(200);

    // Same session, no re-login — the check is live.
    expect((await send('post', '/api/v1/vacancies', vacancyBody(), hr)).status).toBe(403);
    // Reads aren't gated by the module.
    expect((await get('/api/v1/vacancies', hr)).status).toBe(200);

    // Re-enable restores it.
    await send('patch', `/api/v1/users/${teacherUserId}/modules`, { moduleKey: 'recruitment.vacancies', allowed: true }, ownerCookies);
    expect((await send('post', '/api/v1/vacancies', vacancyBody(), hr)).status).toBe(201);
  });

  it('the owner is never restricted by module toggles', async () => {
    await send('patch', `/api/v1/users/${teacherUserId}/modules`, { moduleKey: 'recruitment.vacancies', allowed: false }, ownerCookies);
    expect((await send('post', '/api/v1/vacancies', vacancyBody(), ownerCookies)).status).toBe(201);
    await send('patch', `/api/v1/users/${teacherUserId}/modules`, { moduleKey: 'recruitment.vacancies', allowed: true }, ownerCookies);
  });

  it('rejects toggling a module the user’s roles don’t include (422)', async () => {
    const res = await send('patch', `/api/v1/users/${teacherUserId}/modules`, { moduleKey: 'fees.payments', allowed: false }, ownerCookies);
    expect(res.status).toBe(422);
  });

  it('a non-owner cannot manage modules (403)', async () => {
    const hr = await login(teacher.email, teacher.password);
    expect((await get(`/api/v1/users/${teacherUserId}/modules`, hr)).status).toBe(403);
    expect((await send('patch', `/api/v1/users/${teacherUserId}/modules`, { moduleKey: 'recruitment.hire', allowed: false }, hr)).status).toBe(403);
  });

  it('writes an audit log for a module change', async () => {
    const actions = (await platform.auditLog.findMany({ where: { schoolId, entityId: teacherUserId } })).map((a) => a.action);
    expect(actions).toContain('MODULE_ACCESS_CHANGED');
  });
});
