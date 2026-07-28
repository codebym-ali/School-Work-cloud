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
 * End-to-end auth + tenancy pipeline (blueprint §19, §22): tenant resolution from
 * Host, JWT-cookie login, /auth/me, tenant-mismatch rejection, unknown tenant 404.
 * Exercises the real global guards + interceptor + error envelope.
 */
describe('Auth + tenancy pipeline (e2e)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;

  const schoolA = randomUUID();
  const schoolB = randomUUID();
  const subA = `demo-${schoolA.slice(0, 8)}`;
  const subB = `demo-${schoolB.slice(0, 8)}`;
  const password = 'Sup3rSecret!pw';
  const emailA = 'admin-a@example.com';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

    // School A + a CAMPUS_ADMIN (not in the mandatory-MFA set, so login is one-step).
    await platform.school.create({ data: { id: schoolA, name: 'Demo A', subdomain: subA } });
    const campusA = await platform.campus.create({ data: { schoolId: schoolA, name: 'Main A' } });
    await platform.user.create({
      data: {
        schoolId: schoolA,
        campusId: campusA.id,
        email: emailA,
        passwordHash,
        roles: ['CAMPUS_ADMIN'],
        status: 'ACTIVE',
      },
    });

    // School B (used to prove cross-tenant token replay is rejected).
    await platform.school.create({ data: { id: schoolB, name: 'Demo B', subdomain: subB } });
    await platform.campus.create({ data: { schoolId: schoolB, name: 'Main B' } });
  });

  afterAll(async () => {
    for (const id of [schoolA, schoolB]) await destroyTenant(platform, id);
    await app.close();
  });

  const host = (sub: string) => `${sub}.localhost`;

  it('rejects an unknown tenant with 404 TENANT_NOT_FOUND', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Host', 'nope.localhost')
      .send({ email: emailA, password });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TENANT_NOT_FOUND');
  });

  it('rejects bad credentials with 401 and no tenant leak', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Host', host(subA))
      .send({ email: emailA, password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('logs in and sets httpOnly session cookies', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Host', host(subA))
      .send({ email: emailA, password });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(emailA);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => c.startsWith('access_token='))).toBe(true);
    expect(cookies.some((c) => c.startsWith('refresh_token='))).toBe(true);
    expect(cookies.some((c) => c.includes('HttpOnly') && c.startsWith('access_token'))).toBe(true);
  });

  it('serves /auth/me with the session cookie', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Host', host(subA))
      .send({ email: emailA, password });
    const cookies = login.headers['set-cookie'] as unknown as string[];

    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Host', host(subA))
      .set('Cookie', cookies);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(emailA);
  });

  it('rejects a token replayed on another tenant subdomain (TENANT_MISMATCH)', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Host', host(subA))
      .send({ email: emailA, password });
    const cookies = login.headers['set-cookie'] as unknown as string[];

    const res = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Host', host(subB)) // school B's subdomain, school A's token
      .set('Cookie', cookies);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TENANT_MISMATCH');
  });

  it('blocks /auth/me without a session (401)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Host', host(subA));
    expect(res.status).toBe(401);
  });
});
