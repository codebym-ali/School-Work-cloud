import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../apps/api/src/app.module';
import { PlatformPrismaService } from '@database';

/**
 * Operator management — SA4 (blueprint §24). Managing the vendor team is a SUPER_ADMIN function: list
 * operators, change a role, enable / disable. An operator can NEVER change their OWN role or status —
 * which also protects the last SUPER_ADMIN (nobody else is left to demote or disable them).
 */
describe('Platform operator management (e2e, §24 SA4)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;

  const HOST = 'admin.localhost';
  const password = 'Operator!Secret12';
  // Lowercase only — the login looks up `email.toLowerCase()`, so a stored upper-case letter would
  // never be found (a 401 that looks like bad credentials).
  const superAEmail = `ops-super-a-${randomUUID().slice(0, 8)}@platform.pk`;
  const superBEmail = `ops-super-b-${randomUUID().slice(0, 8)}@platform.pk`;
  const analystEmail = `ops-analyst-${randomUUID().slice(0, 8)}@platform.pk`;
  let superAId: string;
  let superBId: string;
  let analystId: string;

  const server = () => app.getHttpServer();
  const cookiesOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[]) ?? [];
  const cookieHeader = (cs: string[]) => cs.map((c) => c.split(';')[0]).join('; ');
  const csrfOf = (cs: string[]) => (cs.find((c) => c.startsWith('platform_csrf=')) ?? '').split(';')[0].split('=')[1];
  const login = (email: string) =>
    request(server()).post('/api/v1/platform/auth/login').set('Host', HOST).send({ email, password });

  let superACookies: string[];
  let analystCookies: string[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    superAId = (await platform.platformUser.create({ data: { email: superAEmail, name: 'Super A', role: 'SUPER_ADMIN', status: 'ACTIVE', passwordHash } })).id;
    superBId = (await platform.platformUser.create({ data: { email: superBEmail, name: 'Super B', role: 'SUPER_ADMIN', status: 'ACTIVE', passwordHash } })).id;
    analystId = (await platform.platformUser.create({ data: { email: analystEmail, name: 'Analyst', role: 'ANALYST', status: 'ACTIVE', passwordHash } })).id;

    superACookies = cookiesOf(await login(superAEmail));
    analystCookies = cookiesOf(await login(analystEmail));
  });

  afterAll(async () => {
    const ids = [superAId, superBId, analystId].filter(Boolean) as string[];
    for (const uid of ids) {
      await platform.platformAuditLog.deleteMany({ where: { platformUserId: uid } });
      await platform.platformRefreshToken.deleteMany({ where: { platformUserId: uid } });
    }
    await platform.platformUser.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  it('lists operators to a SUPER_ADMIN (200) and never returns a password hash / MFA secret', async () => {
    const res = await request(server()).get('/api/v1/platform/operators').set('Host', HOST).set('Cookie', cookieHeader(superACookies));
    expect(res.status).toBe(200);
    const emails = (res.body as Array<{ email: string }>).map((o) => o.email);
    expect(emails).toEqual(expect.arrayContaining([superAEmail, superBEmail, analystEmail]));
    expect((res.body as Array<Record<string, unknown>>).every((o) => !('passwordHash' in o) && !('mfaSecretEnc' in o))).toBe(true);
  });

  it('forbids an ANALYST from listing operators (403)', async () => {
    const res = await request(server()).get('/api/v1/platform/operators').set('Host', HOST).set('Cookie', cookieHeader(analystCookies));
    expect(res.status).toBe(403);
  });

  it('lets a SUPER_ADMIN change another operator role (200) and audits OPERATOR_UPDATE from→to', async () => {
    const res = await request(server())
      .patch(`/api/v1/platform/operators/${superBId}`)
      .set('Host', HOST).set('Cookie', cookieHeader(superACookies)).set('X-CSRF-Token', csrfOf(superACookies))
      .send({ role: 'SUPPORT' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: superBId, role: 'SUPPORT' });

    const db = await platform.platformUser.findUnique({ where: { id: superBId }, select: { role: true } });
    expect(db?.role).toBe('SUPPORT');

    const rows = await platform.platformAuditLog.findMany({ where: { action: 'OPERATOR_UPDATE', platformUserId: superAId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ operatorId: superBId, role: { from: 'SUPER_ADMIN', to: 'SUPPORT' } });
  });

  it('refuses an operator changing their OWN role or status (422) and leaves it unchanged', async () => {
    const res = await request(server())
      .patch(`/api/v1/platform/operators/${superAId}`)
      .set('Host', HOST).set('Cookie', cookieHeader(superACookies)).set('X-CSRF-Token', csrfOf(superACookies))
      .send({ role: 'SUPPORT' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const db = await platform.platformUser.findUnique({ where: { id: superAId }, select: { role: true } });
    expect(db?.role).toBe('SUPER_ADMIN');
  });

  it('disables another operator (200) → status DISABLED', async () => {
    const res = await request(server())
      .patch(`/api/v1/platform/operators/${superBId}`)
      .set('Host', HOST).set('Cookie', cookieHeader(superACookies)).set('X-CSRF-Token', csrfOf(superACookies))
      .send({ status: 'DISABLED' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: superBId, status: 'DISABLED' });
    const db = await platform.platformUser.findUnique({ where: { id: superBId }, select: { status: true } });
    expect(db?.status).toBe('DISABLED');
  });

  it('forbids an ANALYST from changing an operator (403)', async () => {
    const res = await request(server())
      .patch(`/api/v1/platform/operators/${superBId}`)
      .set('Host', HOST).set('Cookie', cookieHeader(analystCookies)).set('X-CSRF-Token', csrfOf(analystCookies))
      .send({ status: 'ACTIVE' });
    expect(res.status).toBe(403);
  });

  it('404s for an unknown operator', async () => {
    const res = await request(server())
      .patch(`/api/v1/platform/operators/${randomUUID()}`)
      .set('Host', HOST).set('Cookie', cookieHeader(superACookies)).set('X-CSRF-Token', csrfOf(superACookies))
      .send({ role: 'ANALYST' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
