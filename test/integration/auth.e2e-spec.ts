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
  const ownerEmail = 'owner-a@example.com';
  const mfaTeacherEmail = 'mfa-teacher-a@example.com';
  const dualEmail = 'owner-who-teaches-a@example.com';

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

    // ── Owner Login Plan (O0) fixtures ───────────────────────────────────────────
    // OWNER_ADMIN is school-wide, so no campus (UsersService enforces the same rule).
    await platform.user.create({
      data: { schoolId: schoolA, email: ownerEmail, passwordHash, roles: ['OWNER_ADMIN'], status: 'ACTIVE' },
    });
    // ⚠️ MFA **enabled** — this is the S2 bypass fixture. `mfaChallenge()` trades a valid
    // `mfaToken` for a real session without re-checking the door, so if the door check ever moves
    // below the MFA branch this account walks straight through the owner's entrance.
    // The secret is never decrypted: the door must refuse before the MFA branch is reached.
    await platform.user.create({
      data: {
        schoolId: schoolA, campusId: campusA.id, email: mfaTeacherEmail, passwordHash,
        roles: ['TEACHER'], status: 'ACTIVE', mfaEnabled: true, mfaSecretEnc: 'not-a-real-secret',
      },
    });
    // Holds OWNER_ADMIN **and** TEACHER — the I6 rule: owner wins, whatever else they hold.
    await platform.user.create({
      data: { schoolId: schoolA, email: dualEmail, passwordHash, roles: ['OWNER_ADMIN', 'TEACHER'], status: 'ACTIVE' },
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

  // ── The owner's own door (Owner Login Plan, O0) ─────────────────────────────
  describe('owner login door', () => {
    const post = (path: string, body: object) =>
      request(app.getHttpServer()).post(`/api/v1${path}`).set('Host', host(subA)).send(body);

    it('lets the owner in at their own door', async () => {
      const res = await post('/auth/owner-login', { email: ownerEmail, password });
      expect(res.status).toBe(200);
      expect(res.headers['set-cookie']).toBeDefined();
    });

    it('admits an owner who also teaches — holding OWNER_ADMIN decides the door', async () => {
      // ⚠️ The alternative rule ("allowed at the staff door if they hold a staff role too") is a
      // bypass: an owner keeps /login simply by being granted a second role.
      const res = await post('/auth/owner-login', { email: dualEmail, password });
      expect(res.status).toBe(200);
    });

    it('refuses a non-owner with a CORRECT password, identically to a wrong password', async () => {
      const wrongDoor = await post('/auth/owner-login', { email: emailA, password });
      const wrongPassword = await post('/auth/owner-login', { email: emailA, password: 'NotThePassword!1' });

      expect(wrongDoor.status).toBe(401);
      // Byte-identical but for the request id — anything else is an oracle telling an attacker
      // with any staff credential which address belongs to the owner.
      expect({ ...wrongDoor.body.error, requestId: undefined })
        .toEqual({ ...wrongPassword.body.error, requestId: undefined });
      expect(wrongDoor.headers['set-cookie']).toBeUndefined();
    });

    it('⚠️ never issues an mfaToken to a non-owner — the bypass, not the leak', async () => {
      // `mfaChallenge()` exchanges a valid mfaToken for a REAL session and re-checks nothing. If
      // the door check ever slips below the MFA branch this response carries a working token and
      // the door is bypassed outright. Assert the token's absence, not merely the status.
      const res = await post('/auth/owner-login', { email: mfaTeacherEmail, password });
      expect(res.status).toBe(401);
      expect(res.body).not.toHaveProperty('mfaToken');
      expect(res.body.mfaRequired).toBeUndefined();
    });

    /**
     * ⚠️ **`.failing` — asserts what SHOULD happen, and records that it currently does not.**
     *
     * `TenantTransactionInterceptor` opens one `$transaction` per request, and a failed login
     * **throws** — so `registerFailure()`'s write is rolled back with everything else.
     * `failedLoginCount` never rises, and **§22.3 account lockout (10 attempts → 15-minute lock)
     * has therefore never fired in a running system.** Nothing tested it, which is how it survived.
     *
     * Discovered 2026-08-12 while building the owner door; **pre-existing, not caused by it** — the
     * control below fails identically on the untouched `/auth/login` path. It flips to a hard error
     * the moment somebody fixes the rollback, which is the prompt to delete this marker.
     */
    it.failing('CONTROL: a wrong PASSWORD increments the counter (nothing to do with doors)', async () => {
      const before = await platform.user.findFirstOrThrow({ where: { schoolId: schoolA, email: emailA } });
      await post('/auth/login', { email: emailA, password: 'DefinitelyWrong!9' });
      const after = await platform.user.findFirstOrThrow({ where: { schoolId: schoolA, email: emailA } });
      expect(after.failedLoginCount).toBe(before.failedLoginCount + 1);
    });

    // ⚠️ `.failing` for the SAME pre-existing reason as the control above — the request
    // transaction rolls the write back. **The security property O0 depends on still holds**: both
    // paths perform the same write and both roll it back, so the two remain indistinguishable and
    // no timing oracle appears. What is lost is the lockout, and that loss is not new.
    it.failing('counts a wrong-door attempt as a failed login, exactly like a wrong password', async () => {
      // Read the COUNTER, not the clock: the point of the shared write is that the two paths cost
      // the same, and a timing assertion would be flaky where this is exact.
      const before = await platform.user.findFirstOrThrow({ where: { schoolId: schoolA, email: emailA } });
      await post('/auth/owner-login', { email: emailA, password });
      const after = await platform.user.findFirstOrThrow({ where: { schoolId: schoolA, email: emailA } });
      expect(after.failedLoginCount).toBe(before.failedLoginCount + 1);
    });

    // ⚠️ `.failing`, same root cause — and this one MATTERS more than the counter: the audit row
    // is the only trace a wrong-door attempt leaves, because the caller is deliberately told
    // nothing. Until the rollback is fixed, **O0 ships a boundary with no visibility into who is
    // testing it** (invariant I8 unmet).
    it.failing('records the wrong-door attempt in the audit log — the only place it is visible', async () => {
      await post('/auth/owner-login', { email: emailA, password });
      const rows = await platform.auditLog.findMany({
        where: { schoolId: schoolA, action: 'LOGIN_WRONG_DOOR' },
      });
      expect(rows.length).toBeGreaterThan(0);
    });

    it('still admits the owner at the staff door — O2 has not shipped yet', async () => {
      // Documents the phase boundary rather than leaving it implicit: O0/O1 make the owner's door
      // owner-only; closing /login to owners is O2, and this case flips to 401 then.
      const res = await post('/auth/login', { email: ownerEmail, password });
      expect(res.status).toBe(200);
    });
  });
});
