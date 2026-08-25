import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { authenticator } from 'otplib';
import { AppModule } from '../../apps/api/src/app.module';
import { PlatformPrismaService } from '@database';

/**
 * Platform operator MFA (SA0, blueprint §24). The vendor console reaches every tenant's data, so a
 * stolen operator password is a cross-tenant breach; a second factor is the whole point of the
 * control plane's hardening. This mirrors the tenant MFA lifecycle (see mfa-recovery.e2e-spec.ts)
 * on the platform side: enrol with a TOTP derived from the returned secret, receive recovery codes,
 * and then prove that a subsequent login is a two-step door.
 *
 * The `secret`/`recoveryCodes` are threaded through the ordered `it`s exactly as the tenant spec
 * threads its own — enrolment happens once and the challenges that follow reuse it.
 */
describe('Platform operator MFA (e2e, §24 SA0)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;

  const email = `mfa-op-${randomUUID().slice(0, 8)}@platform.pk`;
  const password = 'Operator!Secret12';
  let platformUserId: string;

  let secret: string;
  let recoveryCodes: string[];

  const HOST = 'admin.localhost';
  const server = () => app.getHttpServer();
  const cookiesOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[]) ?? [];
  const cookieHeader = (cs: string[]) => cs.map((c) => c.split(';')[0]).join('; ');
  const csrfOf = (cs: string[]) => (cs.find((c) => c.startsWith('platform_csrf=')) ?? '').split(';')[0].split('=')[1];
  const hasAccessCookie = (cs: string[]) => cs.some((c) => c.startsWith('platform_access_token='));

  const login = () =>
    request(server()).post('/api/v1/platform/auth/login').set('Host', HOST).send({ email, password });
  // The MFA completion carries the mfaToken in its body and holds no session yet, so — like the
  // tenant `/auth/mfa/challenge` — it takes no CSRF header.
  const completeMfa = (mfaToken: string, code: string) =>
    request(server()).post('/api/v1/platform/auth/mfa').set('Host', HOST).send({ mfaToken, code });
  const totp = () => authenticator.generate(secret);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);

    // A fresh operator with MFA OFF — the enrolment flow below turns it on. The second factor is
    // orthogonal to the role split (any operator may protect their own login), so SUPER_ADMIN keeps
    // the fixture simple.
    const op = await platform.platformUser.create({
      data: {
        email,
        name: 'MFA Operator',
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      },
    });
    platformUserId = op.id;
  });

  afterAll(async () => {
    await platform.platformMfaRecoveryCode.deleteMany({ where: { platformUserId } });
    await platform.platformRefreshToken.deleteMany({ where: { platformUserId } });
    await platform.platformUser.deleteMany({ where: { id: platformUserId } });
    await app.close();
  });

  let sessionCookies: string[];

  describe('enrolment then TOTP challenge', () => {
    it('logs the operator in one-step while MFA is off', async () => {
      const res = await login();
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ email, role: 'SUPER_ADMIN', mfaEnabled: false });
      expect(res.body.mfaRequired).toBeUndefined();
      sessionCookies = cookiesOf(res);
      expect(hasAccessCookie(sessionCookies)).toBe(true);
    });

    it('begins enrolment → hands back an otpauth URL and its secret', async () => {
      const res = await request(server())
        .post('/api/v1/platform/auth/mfa/enroll/begin')
        .set('Host', HOST)
        .set('Cookie', cookieHeader(sessionCookies))
        .set('X-CSRF-Token', csrfOf(sessionCookies))
        .send({});
      expect([200, 201]).toContain(res.status);
      secret = res.body.secret;
      expect(secret).toBeTruthy();
      // The same secret rides inside the otpauth URL — the value the /security screen shows for
      // manual entry when a camera can't scan the QR.
      expect(new URL(res.body.otpauthUrl).searchParams.get('secret')).toBe(secret);
    });

    it('confirms enrolment with a TOTP → returns ten recovery codes', async () => {
      const res = await request(server())
        .post('/api/v1/platform/auth/mfa/enroll/confirm')
        .set('Host', HOST)
        .set('Cookie', cookieHeader(sessionCookies))
        .set('X-CSRF-Token', csrfOf(sessionCookies))
        .send({ code: totp() });
      expect([200, 201]).toContain(res.status);
      recoveryCodes = res.body.recoveryCodes;
      // Enrolment itself hands back the codes — a user who must remember to generate them later is a
      // user who won't have them in a crisis.
      expect(recoveryCodes).toHaveLength(10);
      expect(new Set(recoveryCodes).size).toBe(10);
    });

    it('now demands a second factor at login — {mfaRequired, mfaToken} and NO session yet', async () => {
      const res = await login();
      expect(res.status).toBe(200);
      expect(res.body.mfaRequired).toBe(true);
      expect(res.body.mfaToken).toBeTruthy();
      // The half-login must not carry a usable session — the door opens only after the second factor.
      expect(res.body.user).toBeUndefined();
      expect(hasAccessCookie(cookiesOf(res))).toBe(false);
    });

    it('a valid TOTP completes the challenge and issues a real platform session', async () => {
      const step1 = await login();
      const res = await completeMfa(step1.body.mfaToken, totp());
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ email, mfaEnabled: true });
      const cookies = cookiesOf(res);
      expect(hasAccessCookie(cookies)).toBe(true);

      // A real session, not a half-login: /me answers with it and reflects mfaEnabled:true.
      const me = await request(server())
        .get('/api/v1/platform/auth/me')
        .set('Host', HOST)
        .set('Cookie', cookieHeader(cookies));
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ email, role: 'SUPER_ADMIN', mfaEnabled: true });
    });
  });

  describe('recovery codes', () => {
    it('a recovery code stands in for the authenticator and signs the operator in', async () => {
      const step1 = await login();
      expect(step1.body.mfaRequired).toBe(true);

      const res = await completeMfa(step1.body.mfaToken, recoveryCodes[0]);
      expect(res.status).toBe(200);
      expect(hasAccessCookie(cookiesOf(res))).toBe(true);

      // One code is now spent — nine remain unused.
      expect(await platform.platformMfaRecoveryCode.count({ where: { platformUserId, usedAt: null } })).toBe(9);
    });

    it('the same recovery code is dead the second time — single-use', async () => {
      const step1 = await login();
      const res = await completeMfa(step1.body.mfaToken, recoveryCodes[0]);
      expect(res.status).toBe(401);
      // A rejected reuse burns nothing further — still nine unused.
      expect(await platform.platformMfaRecoveryCode.count({ where: { platformUserId, usedAt: null } })).toBe(9);
    });
  });
});
