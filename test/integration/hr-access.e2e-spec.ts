import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';

/**
 * HR access (RBAC): only OWNER_ADMIN may grant the HR_MANAGER role on an EXISTING employee,
 * which unlocks recruitment. Proves the access flips 403 → 200 on grant and back on revoke,
 * that the account is reused (roles preserved, no new login), and that a campus admin cannot
 * grant it.
 */
describe('HR access grant (e2e, RBAC)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let ownerCookies: string[];
  let campusAId: string;
  let teacherUserId: string;

  const sub = `hra-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@hra.pk', password: 'Owner!Secret12' };
  const campusAdmin = { email: 'ca@hra.pk', password: 'Campus!Secret12' };
  const teacher = { email: 'tch@hra.pk', password: 'Teacher!Secret12' };

  const server = () => app.getHttpServer();
  const login = async (email: string, password: string) => {
    const res = await request(server()).post('/api/v1/auth/login').set('Host', host).send({ email, password });
    return { status: res.status, cookies: res.headers['set-cookie'] as unknown as string[] };
  };
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const send = (method: 'post' | 'patch', p: string, b: object, cookies: string[]) =>
    request(server())[method](p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send(b);
  const get = (p: string, cookies: string[]) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const provisioning = app.get(ProvisioningService, { strict: false });
    const prov = await provisioning.provisionSchool({ name: 'HRA School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;
    campusAId = prov.campusId;

    ownerCookies = (await login(owner.email, owner.password)).cookies;
    await send('post', '/api/v1/users', { email: campusAdmin.email, roles: ['CAMPUS_ADMIN'], campusId: campusAId, password: campusAdmin.password }, ownerCookies);
    const t = await send('post', '/api/v1/users', { email: teacher.email, roles: ['TEACHER'], campusId: campusAId, password: teacher.password }, ownerCookies);
    teacherUserId = t.body.id;
  });

  afterAll(async () => {
    const tables = ['auditLog', 'vacancy', 'refreshToken', 'user', 'campus', 'smsTemplate', 'smsCreditLedger', 'school'] as const;
    for (const t of tables) {
      const d = platform[t] as unknown as { deleteMany: (a: unknown) => Promise<unknown> };
      await d.deleteMany({ where: t === 'school' ? { id: schoolId } : { schoolId } }).catch(() => undefined);
    }
    await app.close();
  });

  it('a teacher has no recruitment access until the owner grants it — then loses it on revoke', async () => {
    // Before: the teacher cannot reach recruitment.
    const before = (await login(teacher.email, teacher.password)).cookies;
    expect((await get('/api/v1/vacancies', before)).status).toBe(403);

    // Owner grants HR access — the account is reused, roles preserved + HR_MANAGER added.
    const grant = await send('patch', `/api/v1/users/${teacherUserId}/hr-access`, { grant: true }, ownerCookies);
    expect(grant.status).toBe(200);
    expect(grant.body.roles).toEqual(expect.arrayContaining(['TEACHER', 'HR_MANAGER']));

    // After: a fresh session for the same teacher can now reach recruitment.
    const after = (await login(teacher.email, teacher.password)).cookies;
    expect((await get('/api/v1/vacancies', after)).status).toBe(200);

    // Revoke removes it again.
    const revoke = await send('patch', `/api/v1/users/${teacherUserId}/hr-access`, { grant: false }, ownerCookies);
    expect(revoke.status).toBe(200);
    expect(revoke.body.roles).toEqual(['TEACHER']);
    const revoked = (await login(teacher.email, teacher.password)).cookies;
    expect((await get('/api/v1/vacancies', revoked)).status).toBe(403);
  });

  it('owner makes an existing employee a campus admin (principal), then revokes it', async () => {
    // Before: the teacher cannot reach a campus-admin endpoint (user management).
    const before = (await login(teacher.email, teacher.password)).cookies;
    expect((await get('/api/v1/users', before)).status).toBe(403);

    const grant = await send('patch', `/api/v1/users/${teacherUserId}/campus-admin`, { grant: true }, ownerCookies);
    expect(grant.status).toBe(200);
    expect(grant.body.roles).toEqual(expect.arrayContaining(['TEACHER', 'CAMPUS_ADMIN']));

    const asAdmin = (await login(teacher.email, teacher.password)).cookies;
    expect((await get('/api/v1/users', asAdmin)).status).toBe(200);

    const revoke = await send('patch', `/api/v1/users/${teacherUserId}/campus-admin`, { grant: false }, ownerCookies);
    expect(revoke.body.roles).toEqual(['TEACHER']);
    const revoked = (await login(teacher.email, teacher.password)).cookies;
    expect((await get('/api/v1/users', revoked)).status).toBe(403);
  });

  it('rejects making a campus-less user (the owner) a campus admin → 422', async () => {
    const me = await get('/api/v1/auth/me', ownerCookies);
    const res = await send('patch', `/api/v1/users/${me.body.id}/campus-admin`, { grant: true }, ownerCookies);
    expect(res.status).toBe(422);
  });

  it('a campus admin cannot grant HR or campus-admin access (owner-only) → 403', async () => {
    const caCookies = (await login(campusAdmin.email, campusAdmin.password)).cookies;
    expect((await send('patch', `/api/v1/users/${teacherUserId}/hr-access`, { grant: true }, caCookies)).status).toBe(403);
    expect((await send('patch', `/api/v1/users/${teacherUserId}/campus-admin`, { grant: true }, caCookies)).status).toBe(403);
  });

  it('writes an audit log for the grant and the revoke', async () => {
    const actions = (await platform.auditLog.findMany({ where: { schoolId, entityId: teacherUserId } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['HR_ACCESS_GRANTED', 'HR_ACCESS_REVOKED']));
  });
});
