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
    await platform.refreshToken.deleteMany({ where: { schoolId } });
    await platform.user.deleteMany({ where: { schoolId } });
    await platform.campus.deleteMany({ where: { schoolId } });
    await platform.school.deleteMany({ where: { id: schoolId } });
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
    const ours = (res.body as Array<{ id: string; subdomain: string }>).find((t) => t.id === schoolId);
    expect(ours?.subdomain).toBe(sub);
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
});
