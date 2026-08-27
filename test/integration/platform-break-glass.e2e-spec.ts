import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../apps/api/src/app.module';
import { PlatformPrismaService } from '@database';
import { destroyTenant } from './support/tenant';

/**
 * Break-glass "login-as" — SA5 (blueprint §24, SA-P8). A SUPER_ADMIN or SUPPORT starts a short-lived,
 * read-only session into ONE school. The session rides the NORMAL tenant path, so it is confined to
 * that one school by TenantScopeGuard (rejected on any other host) + RLS — never the BYPASSRLS
 * connection. This proves the three load-bearing properties: it enters exactly one tenant, it cannot
 * reach a second, and it cannot write.
 */
describe('Platform break-glass login-as (e2e, §24 SA5)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;

  const ADMIN_HOST = 'admin.localhost';
  const password = 'Operator!Secret12';
  const superEmail = `bg-super-${randomUUID().slice(0, 8)}@platform.pk`;
  const supportEmail = `bg-support-${randomUUID().slice(0, 8)}@platform.pk`;
  const analystEmail = `bg-analyst-${randomUUID().slice(0, 8)}@platform.pk`;
  let superId: string;
  let supportId: string;
  let analystId: string;

  // Two schools: A is the break-glass target; B is the tenant the session must NOT be able to reach.
  const schoolA = randomUUID();
  const schoolB = randomUUID();
  const subA = `bg-a-${schoolA.slice(0, 8)}`;
  const subB = `bg-b-${schoolB.slice(0, 8)}`;

  const server = () => app.getHttpServer();
  const cookiesOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[]) ?? [];
  const cookieHeader = (cs: string[]) => cs.map((c) => c.split(';')[0]).join('; ');
  const csrfOf = (cs: string[]) => (cs.find((c) => c.startsWith('platform_csrf=')) ?? '').split(';')[0].split('=')[1];
  const login = (email: string) => request(server()).post('/api/v1/platform/auth/login').set('Host', ADMIN_HOST).send({ email, password });

  let superCookies: string[];
  let supportCookies: string[];
  let analystCookies: string[];

  const startBreakGlass = (cookies: string[], schoolId: string, reason: unknown) =>
    request(server())
      .post(`/api/v1/platform/tenants/${schoolId}/break-glass`)
      .set('Host', ADMIN_HOST).set('Cookie', cookieHeader(cookies)).set('X-CSRF-Token', csrfOf(cookies))
      .send({ reason });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    superId = (await platform.platformUser.create({ data: { email: superEmail, name: 'BG Super', role: 'SUPER_ADMIN', status: 'ACTIVE', passwordHash } })).id;
    supportId = (await platform.platformUser.create({ data: { email: supportEmail, name: 'BG Support', role: 'SUPPORT', status: 'ACTIVE', passwordHash } })).id;
    analystId = (await platform.platformUser.create({ data: { email: analystEmail, name: 'BG Analyst', role: 'ANALYST', status: 'ACTIVE', passwordHash } })).id;

    for (const [id, name, sub] of [[schoolA, 'BG School A', subA], [schoolB, 'BG School B', subB]] as const) {
      await platform.school.create({ data: { id, name, subdomain: sub } });
      await platform.campus.create({ data: { schoolId: id, name: 'Main' } });
    }

    superCookies = cookiesOf(await login(superEmail));
    supportCookies = cookiesOf(await login(supportEmail));
    analystCookies = cookiesOf(await login(analystEmail));
  });

  afterAll(async () => {
    const ids = [superId, supportId, analystId].filter(Boolean) as string[];
    for (const uid of ids) {
      await platform.platformAuditLog.deleteMany({ where: { platformUserId: uid } });
      await platform.platformRefreshToken.deleteMany({ where: { platformUserId: uid } });
    }
    for (const sid of [schoolA, schoolB]) await destroyTenant(platform, sid);
    await platform.platformUser.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  it('a SUPER_ADMIN starts a break-glass session (200) and it is audited BREAK_GLASS_START with the reason', async () => {
    const res = await startBreakGlass(superCookies, schoolA, 'Fee screen not loading — ticket 4821');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ schoolId: schoolA, subdomain: subA });
    expect(typeof res.body.token).toBe('string');
    expect(typeof res.body.expiresAt).toBe('string');

    const rows = await platform.platformAuditLog.findMany({ where: { action: 'BREAK_GLASS_START', targetTenantId: schoolA } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ platformUserId: superId, reason: 'Fee screen not loading — ticket 4821' });
  });

  it('a SUPPORT operator may start break-glass (200); an ANALYST may not (403)', async () => {
    expect((await startBreakGlass(supportCookies, schoolA, 'assist')).status).toBe(200);
    expect((await startBreakGlass(analystCookies, schoolA, 'assist')).status).toBe(403);
  });

  it('requires a reason (400)', async () => {
    expect((await startBreakGlass(superCookies, schoolA, '')).status).toBe(400);
  });

  it('the scoped session reads the target school (200), and enter sets the cookie', async () => {
    const token = (await startBreakGlass(superCookies, schoolA, 'read test')).body.token as string;

    // enter sets the read-only session cookie on the school's own host.
    const entered = await request(server()).post('/api/v1/auth/break-glass-enter').set('Host', `${subA}.localhost`).send({ token });
    expect(entered.status).toBe(204);
    expect(cookiesOf(entered).some((c) => c.startsWith('access_token='))).toBe(true);

    // A real tenant read on A's host succeeds (RLS-scoped to A).
    const read = await request(server())
      .get('/api/v1/students')
      .set('Host', `${subA}.localhost`)
      .set('Cookie', `access_token=${token}`);
    expect(read.status).toBe(200);
  });

  it('is CONFINED to the target school — the same token is rejected on another school host (403)', async () => {
    const token = (await startBreakGlass(superCookies, schoolA, 'confinement test')).body.token as string;
    const res = await request(server())
      .get('/api/v1/students')
      .set('Host', `${subB}.localhost`) // school B — the session must not reach it
      .set('Cookie', `access_token=${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TENANT_MISMATCH');
  });

  it('is READ-ONLY — a write with the break-glass session is refused (403)', async () => {
    const token = (await startBreakGlass(superCookies, schoolA, 'readonly test')).body.token as string;
    const res = await request(server())
      .post('/api/v1/users')
      .set('Host', `${subA}.localhost`)
      .set('Cookie', `access_token=${token}`)
      .send({ email: 'x@example.com', roles: ['TEACHER'] });
    expect(res.status).toBe(403);
  });
});
