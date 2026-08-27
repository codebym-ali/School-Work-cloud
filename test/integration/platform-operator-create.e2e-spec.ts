import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../apps/api/src/app.module';
import { PlatformPrismaService } from '@database';

/**
 * Operator invite & onboarding — SA4b (blueprint §24). A SUPER_ADMIN invites an operator with NO
 * password (SA-P3); the API returns a one-time onboarding token. The operator can't sign in until they
 * set their own password via the public set-password endpoint (which flips INVITED → ACTIVE).
 */
describe('Platform operator invite & onboarding (e2e, §24 SA4b)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;

  const HOST = 'admin.localhost';
  const password = 'Operator!Secret12';
  const superEmail = `inv-super-${randomUUID().slice(0, 8)}@platform.pk`;
  const analystEmail = `inv-analyst-${randomUUID().slice(0, 8)}@platform.pk`;
  let superId: string;
  let analystId: string;

  // Deliberately MixedCase to prove the create lowercases it — otherwise login (which looks up
  // email.toLowerCase()) could never find the operator.
  const inviteEmailInput = `Invited.Op-${randomUUID().slice(0, 8)}@Platform.PK`;
  const inviteEmail = inviteEmailInput.toLowerCase();
  const invitePassword = 'BrandNew!Pass12';
  let inviteId: string;
  let onboardingToken: string;

  const server = () => app.getHttpServer();
  const cookiesOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[]) ?? [];
  const cookieHeader = (cs: string[]) => cs.map((c) => c.split(';')[0]).join('; ');
  const csrfOf = (cs: string[]) => (cs.find((c) => c.startsWith('platform_csrf=')) ?? '').split(';')[0].split('=')[1];
  const login = (email: string, pw: string) =>
    request(server()).post('/api/v1/platform/auth/login').set('Host', HOST).send({ email, password: pw });

  let superCookies: string[];
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
    superId = (await platform.platformUser.create({ data: { email: superEmail, name: 'Inv Super', role: 'SUPER_ADMIN', status: 'ACTIVE', passwordHash } })).id;
    analystId = (await platform.platformUser.create({ data: { email: analystEmail, name: 'Inv Analyst', role: 'ANALYST', status: 'ACTIVE', passwordHash } })).id;

    superCookies = cookiesOf(await login(superEmail, password));
    analystCookies = cookiesOf(await login(analystEmail, password));
  });

  afterAll(async () => {
    const ids = [superId, analystId, inviteId].filter(Boolean) as string[];
    for (const uid of ids) {
      await platform.platformAuditLog.deleteMany({ where: { platformUserId: uid } });
      await platform.platformRefreshToken.deleteMany({ where: { platformUserId: uid } });
      await platform.platformPasswordResetToken.deleteMany({ where: { platformUserId: uid } });
    }
    await platform.platformUser.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  it('invites an operator (201) with a lowercased email + onboarding token, no password stored', async () => {
    const res = await request(server())
      .post('/api/v1/platform/operators')
      .set('Host', HOST).set('Cookie', cookieHeader(superCookies)).set('X-CSRF-Token', csrfOf(superCookies))
      .send({ email: inviteEmailInput, name: 'Invited Op', role: 'SUPPORT' });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe(inviteEmail); // lowercased so login can find it
    expect(typeof res.body.onboardingToken).toBe('string');
    inviteId = res.body.id;
    onboardingToken = res.body.onboardingToken;

    const db = await platform.platformUser.findUnique({ where: { id: inviteId }, select: { status: true, passwordHash: true, role: true } });
    expect(db).toMatchObject({ status: 'INVITED', passwordHash: null, role: 'SUPPORT' });
  });

  it('refuses to sign in before the password is set (401)', async () => {
    const res = await login(inviteEmail, invitePassword);
    expect(res.status).toBe(401);
  });

  it('the console refuses a typed password on invite (SA-P3 — 400)', async () => {
    const res = await request(server())
      .post('/api/v1/platform/operators')
      .set('Host', HOST).set('Cookie', cookieHeader(superCookies)).set('X-CSRF-Token', csrfOf(superCookies))
      .send({ email: `typed-${randomUUID().slice(0, 8)}@platform.pk`, role: 'ANALYST', password: 'TypedIn!Console1' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('sets the password via the onboarding token (204) → operator becomes ACTIVE and can sign in', async () => {
    const set = await request(server())
      .post('/api/v1/platform/auth/set-password')
      .set('Host', HOST)
      .send({ token: onboardingToken, newPassword: invitePassword });
    expect(set.status).toBe(204);

    const db = await platform.platformUser.findUnique({ where: { id: inviteId }, select: { status: true } });
    expect(db?.status).toBe('ACTIVE');

    const res = await login(inviteEmail, invitePassword);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(inviteEmail);
  });

  it('rejects a reused / invalid onboarding token (422)', async () => {
    const res = await request(server())
      .post('/api/v1/platform/auth/set-password')
      .set('Host', HOST)
      .send({ token: onboardingToken, newPassword: 'AnotherOne!12' }); // already consumed above
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('forbids an ANALYST from inviting an operator (403)', async () => {
    const res = await request(server())
      .post('/api/v1/platform/operators')
      .set('Host', HOST).set('Cookie', cookieHeader(analystCookies)).set('X-CSRF-Token', csrfOf(analystCookies))
      .send({ email: `nope-${randomUUID().slice(0, 8)}@platform.pk`, role: 'ANALYST' });
    expect(res.status).toBe(403);
  });

  it('rejects a duplicate operator email (409)', async () => {
    const res = await request(server())
      .post('/api/v1/platform/operators')
      .set('Host', HOST).set('Cookie', cookieHeader(superCookies)).set('X-CSRF-Token', csrfOf(superCookies))
      .send({ email: inviteEmailInput, role: 'ANALYST' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });
});
