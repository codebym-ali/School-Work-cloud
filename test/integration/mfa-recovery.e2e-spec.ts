import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { authenticator } from 'otplib';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { destroyTenant } from './support/tenant';
import { loginRequest } from './support/login';

/**
 * MFA recovery codes (§22.5) — and, incidentally, the first automated coverage of the MFA
 * lifecycle at all.
 *
 * The failure this guards against is total: MFA is MANDATORY for OWNER_ADMIN and ACCOUNTANT, so
 * before recovery codes existed a lost or wiped authenticator locked a school out of its own
 * system with no remedy but an operator editing `mfa_enabled` in the database. Every case below
 * is a step on that recovery path, or a way it could be subverted.
 */
describe('MFA recovery codes (e2e, §22.5)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let userId: string;
  let secret: string;
  let codes: string[];

  const sub = `mfa-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@mfa.pk', password: 'Owner!Secret12' };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const login = () => loginRequest(server(), host, owner.email, owner.password);
  const challenge = (mfaToken: string, code: string) =>
    request(server()).post('/api/v1/auth/mfa/challenge').set('Host', host).send({ mfaToken, code });
  const totp = () => authenticator.generate(secret);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const provisioning = app.get(ProvisioningService, { strict: false });
    const prov = await provisioning.provisionSchool({ name: 'MFA School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;

    const first = await login();
    const cookies = first.headers['set-cookie'] as unknown as string[];
    const csrf = csrfOf(cookies);
    const auth = (p: string, b: object) =>
      request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).send(b);

    const setup = await auth('/api/v1/auth/mfa/setup', {});
    expect(setup.status).toBe(201);
    // The secret is carried inside the otpauth URL — the same value the /security screen shows
    // for manual entry when a camera can't scan the QR.
    secret = new URL(setup.body.otpauthUrl).searchParams.get('secret')!;
    expect(secret).toBeTruthy();

    // Enrolment itself hands back the codes: a user who must remember to generate them later is
    // a user who won't have them in a crisis.
    const verify = await auth('/api/v1/auth/mfa/verify', { code: totp() });
    expect(verify.status).toBe(200);
    codes = verify.body.recoveryCodes;
    userId = (await platform.user.findFirst({ where: { schoolId, email: owner.email } }))!.id;
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('issues ten unique, transcribable codes and stores none of them in the clear', async () => {
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    // No look-alike glyphs (0/O, 1/I/l) — these get written on paper and typed back under stress.
    for (const c of codes) expect(c).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);

    const stored = await platform.mfaRecoveryCode.findMany({ where: { userId } });
    expect(stored).toHaveLength(10);
    for (const row of stored) {
      expect(row.codeHash).toMatch(/^\$argon2/); // hashed like a password, unrecoverable
      expect(codes).not.toContain(row.codeHash);
    }
  });

  it('a lost authenticator is recoverable: a code signs the user in', async () => {
    const step1 = await login();
    expect(step1.body.mfaRequired).toBe(true);

    const res = await challenge(step1.body.mfaToken, codes[0]);
    expect(res.status).toBe(200);
    expect(res.body.usedRecoveryCode).toBe(true);
    expect(res.body.recoveryCodesRemaining).toBe(9);

    // A real session, not a half-login.
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const me = await request(server()).get('/api/v1/auth/me').set('Host', host).set('Cookie', cookies);
    expect(me.status).toBe(200);
  });

  it('a used code is dead — the same one cannot sign in twice', async () => {
    const step1 = await login();
    const res = await challenge(step1.body.mfaToken, codes[0]);
    expect(res.status).toBe(401);
    expect(await platform.mfaRecoveryCode.count({ where: { userId, usedAt: null } })).toBe(9);
  });

  it('accepts a code case- and dash-insensitively — it is copied off paper', async () => {
    const step1 = await login();
    const messy = codes[1].toLowerCase().replace('-', ' ');
    const res = await challenge(step1.body.mfaToken, messy);
    expect(res.status).toBe(200);
    expect(res.body.usedRecoveryCode).toBe(true);
  });

  it('the authenticator still works, and is not reported as a recovery code', async () => {
    const step1 = await login();
    const res = await challenge(step1.body.mfaToken, totp());
    expect(res.status).toBe(200);
    expect(res.body.usedRecoveryCode).toBeUndefined();
    // A TOTP success must not silently burn a recovery code.
    expect(await platform.mfaRecoveryCode.count({ where: { userId, usedAt: null } })).toBe(8);
  });

  it('a wrong code is rejected and burns nothing', async () => {
    const before = await platform.mfaRecoveryCode.count({ where: { userId, usedAt: null } });
    const step1 = await login();
    expect((await challenge(step1.body.mfaToken, 'ZZZZZ-ZZZZZ')).status).toBe(401);
    expect(await platform.mfaRecoveryCode.count({ where: { userId, usedAt: null } })).toBe(before);
  });

  it('regenerating replaces the whole set, retiring every old code', async () => {
    const step1 = await login();
    const sessionCookies = (await challenge(step1.body.mfaToken, totp())).headers['set-cookie'] as unknown as string[];
    const regen = await request(server()).post('/api/v1/auth/mfa/recovery-codes')
      .set('Host', host).set('Cookie', sessionCookies).set('X-CSRF-Token', csrfOf(sessionCookies)).send({});
    expect(regen.body.recoveryCodes).toHaveLength(10);

    // Exactly ten again — a half-old, half-new pile is impossible to reason about.
    expect(await platform.mfaRecoveryCode.count({ where: { userId } })).toBe(10);

    // An old, previously UNUSED code no longer works.
    const stale = await login();
    expect((await challenge(stale.body.mfaToken, codes[3])).status).toBe(401);

    // A new one does.
    const fresh = await login();
    expect((await challenge(fresh.body.mfaToken, regen.body.recoveryCodes[0])).status).toBe(200);
    codes = regen.body.recoveryCodes;
  });

  it('turning MFA off deletes the codes — they must not outlive the factor they recover', async () => {
    const step1 = await login();
    const cookies = (await challenge(step1.body.mfaToken, totp())).headers['set-cookie'] as unknown as string[];
    const res = await request(server()).delete('/api/v1/auth/mfa')
      .set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies))
      .send({ password: owner.password, code: totp() });
    expect(res.status).toBe(204);

    expect(await platform.mfaRecoveryCode.count({ where: { userId } })).toBe(0);
    // And login is one-step again.
    expect((await login()).body.mfaRequired).toBeUndefined();
  });
});
