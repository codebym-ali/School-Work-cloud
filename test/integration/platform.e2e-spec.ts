import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../apps/api/src/app.module';
import { PlatformPrismaService } from '@database';

/**
 * Vendor console (blueprint §24): a platform admin authenticates cross-tenant (no
 * tenant host), lists tenants, suspends one, and that tenant's login immediately turns
 * into 403 TENANT_SUSPENDED — then reactivate restores it. Exercises the real platform
 * auth guard + CSRF + the host-resolution cache invalidation.
 */
describe('Platform vendor console (e2e, §24)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;

  const platformEmail = `admin-${randomUUID().slice(0, 8)}@platform.pk`;
  const platformPassword = 'Admin!Secret12';
  let platformUserId: string;

  const schoolId = randomUUID();
  const sub = `plat-${schoolId.slice(0, 8)}`;
  const ownerEmail = 'owner-plat@example.com';
  const ownerPassword = 'Sup3rSecret!pw';

  // A second tenant provisioned via the console endpoint (POST /platform/tenants).
  const provSub = `prov-${randomUUID().slice(0, 8)}`;
  const provOwnerEmail = `owner-${provSub}@example.com`;
  const provOwnerPassword = 'Pr0visioned!pw';
  let provSchoolId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);

    const pUser = await platform.platformUser.create({
      data: {
        email: platformEmail,
        name: 'Test Platform Admin',
        status: 'ACTIVE',
        passwordHash: await argon2.hash(platformPassword, { type: argon2.argon2id }),
      },
    });
    platformUserId = pUser.id;

    // A tenant with a CAMPUS_ADMIN (no mandatory MFA) so its login is one-step.
    await platform.school.create({ data: { id: schoolId, name: 'Plat Tenant', subdomain: sub } });
    const campus = await platform.campus.create({ data: { schoolId, name: 'Main' } });
    await platform.user.create({
      data: {
        schoolId,
        campusId: campus.id,
        email: ownerEmail,
        roles: ['CAMPUS_ADMIN'],
        status: 'ACTIVE',
        passwordHash: await argon2.hash(ownerPassword, { type: argon2.argon2id }),
      },
    });
  });

  afterAll(async () => {
    for (const sid of [schoolId, provSchoolId].filter(Boolean) as string[]) {
      await platform.refreshToken.deleteMany({ where: { schoolId: sid } });
      await platform.smsCreditLedger.deleteMany({ where: { schoolId: sid } });
      await platform.smsTemplate.deleteMany({ where: { schoolId: sid } });
      await platform.user.deleteMany({ where: { schoolId: sid } });
      await platform.campus.deleteMany({ where: { schoolId: sid } });
      await platform.school.deleteMany({ where: { id: sid } });
    }
    await platform.platformRefreshToken.deleteMany({ where: { platformUserId } });
    await platform.platformUser.deleteMany({ where: { id: platformUserId } });
    await app.close();
  });

  const server = () => app.getHttpServer();
  const cookiesOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[]) ?? [];
  const cookieHeader = (cs: string[]) => cs.map((c) => c.split(';')[0]).join('; ');
  const csrfOf = (cs: string[]) => (cs.find((c) => c.startsWith('platform_csrf=')) ?? '').split(';')[0].split('=')[1];

  const tenantLogin = () =>
    request(server()).post('/api/v1/auth/login').set('Host', `${sub}.localhost`).send({ email: ownerEmail, password: ownerPassword });

  let sessionCookies: string[];

  it('rejects platform login with bad credentials (401)', async () => {
    const res = await request(server())
      .post('/api/v1/platform/auth/login')
      .set('Host', 'admin.localhost')
      .send({ email: platformEmail, password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('logs the platform admin in (no tenant host) and sets platform cookies', async () => {
    const res = await request(server())
      .post('/api/v1/platform/auth/login')
      .set('Host', 'admin.localhost')
      .send({ email: platformEmail, password: platformPassword });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(platformEmail);
    sessionCookies = cookiesOf(res);
    expect(sessionCookies.some((c) => c.startsWith('platform_access_token='))).toBe(true);
    expect(sessionCookies.some((c) => c.startsWith('platform_csrf='))).toBe(true);
  });

  it('blocks the console without a platform session (401)', async () => {
    const res = await request(server()).get('/api/v1/platform/tenants').set('Host', 'admin.localhost');
    expect(res.status).toBe(401);
  });

  it('lists tenants including our seeded school', async () => {
    const res = await request(server())
      .get('/api/v1/platform/tenants')
      .set('Host', 'admin.localhost')
      .set('Cookie', cookieHeader(sessionCookies));
    expect(res.status).toBe(200);
    expect(typeof res.body.total).toBe('number');
    const ours = (res.body.data as Array<{ id: string; subdomain: string }>).find((t) => t.id === schoolId);
    expect(ours?.subdomain).toBe(sub);
  });

  it('filters tenants by search (name / subdomain)', async () => {
    const res = await request(server())
      .get('/api/v1/platform/tenants')
      .query({ search: sub })
      .set('Host', 'admin.localhost')
      .set('Cookie', cookieHeader(sessionCookies));
    expect(res.status).toBe(200);
    const rows = res.body.data as Array<{ id: string; subdomain: string }>;
    expect(rows.some((t) => t.id === schoolId)).toBe(true);
    expect(rows.every((t) => t.subdomain.includes(sub) || t.id === schoolId)).toBe(true);
  });

  const provOwnerLogin = () =>
    request(server())
      .post('/api/v1/auth/login')
      .set('Host', `${provSub}.localhost`)
      .send({ email: provOwnerEmail, password: provOwnerPassword });

  it('provisions a new tenant → it appears in the list and its owner can log in', async () => {
    const res = await request(server())
      .post('/api/v1/platform/tenants')
      .set('Host', 'admin.localhost')
      .set('Cookie', cookieHeader(sessionCookies))
      .set('X-CSRF-Token', csrfOf(sessionCookies))
      .send({ name: 'Provisioned School', subdomain: provSub, ownerEmail: provOwnerEmail, ownerPassword: provOwnerPassword });
    expect(res.status).toBe(201);
    expect(res.body.subdomain).toBe(provSub);
    provSchoolId = res.body.id;

    const list = await request(server())
      .get('/api/v1/platform/tenants')
      .set('Host', 'admin.localhost')
      .set('Cookie', cookieHeader(sessionCookies));
    expect((list.body.data as Array<{ id: string }>).some((t) => t.id === provSchoolId)).toBe(true);

    // The provisioned OWNER_ADMIN can authenticate against their new tenant host.
    expect((await provOwnerLogin()).status).toBe(200);
  });

  it('rejects provisioning a duplicate subdomain (409 CONFLICT)', async () => {
    const res = await request(server())
      .post('/api/v1/platform/tenants')
      .set('Host', 'admin.localhost')
      .set('Cookie', cookieHeader(sessionCookies))
      .set('X-CSRF-Token', csrfOf(sessionCookies))
      .send({ name: 'Dupe', subdomain: provSub, ownerEmail: `dupe-${provSub}@example.com`, ownerPassword: provOwnerPassword });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects an invalid subdomain (400 VALIDATION_FAILED)', async () => {
    const res = await request(server())
      .post('/api/v1/platform/tenants')
      .set('Host', 'admin.localhost')
      .set('Cookie', cookieHeader(sessionCookies))
      .set('X-CSRF-Token', csrfOf(sessionCookies))
      .send({ name: 'Bad', subdomain: 'Bad_Sub Domain', ownerEmail: 'x@example.com', ownerPassword: provOwnerPassword });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a suspend without the CSRF header (403)', async () => {
    const res = await request(server())
      .post(`/api/v1/platform/tenants/${schoolId}/suspend`)
      .set('Host', 'admin.localhost')
      .set('Cookie', cookieHeader(sessionCookies));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });

  it('suspends the tenant → its login becomes 403 TENANT_SUSPENDED', async () => {
    // Tenant can log in before suspension.
    expect((await tenantLogin()).status).toBe(200);

    const res = await request(server())
      .post(`/api/v1/platform/tenants/${schoolId}/suspend`)
      .set('Host', 'admin.localhost')
      .set('Cookie', cookieHeader(sessionCookies))
      .set('X-CSRF-Token', csrfOf(sessionCookies));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: schoolId, isActive: false });

    const after = await tenantLogin();
    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe('TENANT_SUSPENDED');
  });

  it('reactivates the tenant → its login works again', async () => {
    const res = await request(server())
      .post(`/api/v1/platform/tenants/${schoolId}/reactivate`)
      .set('Host', 'admin.localhost')
      .set('Cookie', cookieHeader(sessionCookies))
      .set('X-CSRF-Token', csrfOf(sessionCookies));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: schoolId, isActive: true });

    expect((await tenantLogin()).status).toBe(200);
  });

  it('revokes an operator immediately when disabled (unexpired token rejected)', async () => {
    const tmp = await platform.platformUser.create({
      data: {
        email: `disable-${randomUUID().slice(0, 8)}@platform.pk`,
        name: 'Temp',
        status: 'ACTIVE',
        passwordHash: await argon2.hash('Temp!Secret12', { type: argon2.argon2id }),
      },
    });
    try {
      const login = await request(server())
        .post('/api/v1/platform/auth/login')
        .set('Host', 'admin.localhost')
        .send({ email: tmp.email, password: 'Temp!Secret12' });
      expect(login.status).toBe(200);
      const cookies = cookiesOf(login);

      // Works while ACTIVE.
      const before = await request(server())
        .get('/api/v1/platform/tenants')
        .set('Host', 'admin.localhost')
        .set('Cookie', cookieHeader(cookies));
      expect(before.status).toBe(200);

      // Disable the operator — the SAME (unexpired) token must now be rejected.
      await platform.platformUser.update({ where: { id: tmp.id }, data: { status: 'DISABLED' } });
      const after = await request(server())
        .get('/api/v1/platform/tenants')
        .set('Host', 'admin.localhost')
        .set('Cookie', cookieHeader(cookies));
      expect(after.status).toBe(401);
      expect(after.body.error.code).toBe('UNAUTHENTICATED');
    } finally {
      await platform.platformUser.delete({ where: { id: tmp.id } });
    }
  });

  const refreshCookieOf = (cs: string[]) => (cs.find((c) => c.startsWith('platform_refresh_token=')) ?? '').split(';')[0];
  const platformLogin = () =>
    request(server()).post('/api/v1/platform/auth/login').set('Host', 'admin.localhost').send({ email: platformEmail, password: platformPassword });
  const platformRefresh = (cookie: string) =>
    request(server()).post('/api/v1/platform/auth/refresh').set('Host', 'admin.localhost').set('Cookie', cookie);

  it('login issues a rotating refresh token', async () => {
    const res = await platformLogin();
    expect(res.status).toBe(200);
    expect(refreshCookieOf(cookiesOf(res))).toContain('platform_refresh_token=');
  });

  it('single-use rotation: the used refresh token is rejected, and reuse revokes the whole family', async () => {
    const refresh1 = refreshCookieOf(cookiesOf(await platformLogin()));

    // Rotate once → a NEW refresh token; refresh1 is now revoked.
    const rotated = await platformRefresh(refresh1);
    expect(rotated.status).toBe(200);
    const refresh2 = refreshCookieOf(cookiesOf(rotated));
    expect(refresh2).not.toBe(refresh1);

    // Reuse of the already-rotated refresh1 → 401 + theft response (revoke the family).
    const reuse = await platformRefresh(refresh1);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('REFRESH_INVALID');

    // Because the family was revoked, the previously-valid refresh2 no longer works either.
    expect((await platformRefresh(refresh2)).status).toBe(401);
  });

  it('logout revokes the refresh family', async () => {
    const refresh = refreshCookieOf(cookiesOf(await platformLogin()));
    const out = await request(server()).post('/api/v1/platform/auth/logout').set('Host', 'admin.localhost').set('Cookie', refresh);
    expect(out.status).toBe(204);
    expect((await platformRefresh(refresh)).status).toBe(401);
  });
});
