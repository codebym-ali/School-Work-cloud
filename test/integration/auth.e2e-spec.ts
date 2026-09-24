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
  let campusAId: string;

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
    campusAId = campusA.id;
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
    // QA B: /auth/me carries `name` for the shell greeting — null when the user has no staff profile
    // (a directly-seeded user), the staff-profile full name otherwise (verified live for a teacher).
    expect(me.body).toHaveProperty('name');
    expect(me.body.name).toBeNull();
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
     * The regression guard for the defect this work uncovered: the per-request `$transaction` was
     * rolling `registerFailure()` back, so `failedLoginCount` never rose and **§22.3 lockout had
     * never fired in a running system**. Fixed 2026-08-12 by writing failures outside the request
     * transaction. Kept as a CONTROL on the untouched `/auth/login` path, because that is what
     * proved the defect was pre-existing rather than a fault in the new owner door.
     */
    it('CONTROL: a wrong PASSWORD increments the counter (nothing to do with doors)', async () => {
      const before = await platform.user.findFirstOrThrow({ where: { schoolId: schoolA, email: emailA } });
      await post('/auth/login', { email: emailA, password: 'DefinitelyWrong!9' });
      const after = await platform.user.findFirstOrThrow({ where: { schoolId: schoolA, email: emailA } });
      expect(after.failedLoginCount).toBe(before.failedLoginCount + 1);
    });

    // I4: the two paths must cost the same. A wrong-door attempt that skipped the write would
    // return measurably sooner than a wrong password, and the timing alone would rebuild the
    // oracle the shared error message exists to prevent.
    it('counts a wrong-door attempt as a failed login, exactly like a wrong password', async () => {
      // Read the COUNTER, not the clock: the point of the shared write is that the two paths cost
      // the same, and a timing assertion would be flaky where this is exact.
      const before = await platform.user.findFirstOrThrow({ where: { schoolId: schoolA, email: emailA } });
      await post('/auth/owner-login', { email: emailA, password });
      const after = await platform.user.findFirstOrThrow({ where: { schoolId: schoolA, email: emailA } });
      expect(after.failedLoginCount).toBe(before.failedLoginCount + 1);
    });

    // I8 — and this matters more than the counter: the caller is deliberately told nothing, so the
    // audit row is the ONLY trace a wrong-door attempt leaves. Without it the door would be a
    // boundary with no visibility into who is testing it.
    it('records the wrong-door attempt in the audit log — the only place it is visible', async () => {
      await post('/auth/owner-login', { email: emailA, password });
      const rows = await platform.auditLog.findMany({
        where: { schoolId: schoolA, action: 'LOGIN_WRONG_DOOR' },
      });
      expect(rows.length).toBeGreaterThan(0);
    });

    it('locks the account after repeated failures — the rule that had never once fired', async () => {
      // ⚠️ **§22.3 lockout had no test at all**, which is exactly how a rolled-back write survived
      // in `main` unnoticed. Ten wrong passwords must leave the account LOCKED and refuse an
      // otherwise-correct one.
      const email = 'lockme@example.com';
      const hash = await argon2.hash(password, { type: argon2.argon2id });
      const victim = await platform.user.create({
        data: { schoolId: schoolA, campusId: campusAId, email, passwordHash: hash, roles: ['TEACHER'], status: 'ACTIVE' },
      });

      for (let i = 0; i < 10; i += 1) await post('/auth/login', { email, password: 'Wrong!Password9' });

      const after = await platform.user.findUniqueOrThrow({ where: { id: victim.id } });
      expect(after.failedLoginCount).toBeGreaterThanOrEqual(10);
      expect(after.status).toBe('LOCKED');

      // …and the CORRECT password is now refused, which is the point of locking.
      const res = await post('/auth/login', { email, password });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
    });

    it('refuses the owner at the STAFF door — the doors are mutually exclusive (O2)', async () => {
      // The other half of the boundary. Without this the owner merely had a second entrance and
      // the separation was a label.
      const res = await post('/auth/login', { email: ownerEmail, password });
      expect(res.status).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('refuses the owner at the staff door INDISTINGUISHABLY from a wrong password', async () => {
      // ⚠️ The mirror-image oracle. If /login answered an owner differently from a bad password,
      // the STAFF page would become the owner-detector — the exact leak the owner door exists to
      // prevent, reintroduced from the other side. This is the assertion the 33 other suites do not
      // make: they use the `auto` door helper and would not notice if this boundary disappeared.
      const wrongDoor = await post('/auth/login', { email: ownerEmail, password });
      const wrongPassword = await post('/auth/login', { email: ownerEmail, password: 'NotIt!12345' });
      expect({ ...wrongDoor.body.error, requestId: undefined })
        .toEqual({ ...wrongPassword.body.error, requestId: undefined });
    });

    it('a dual-role owner is refused at the staff door too — a second role is not a way back in', async () => {
      // I6: holding OWNER_ADMIN decides the door, whatever else you hold. The tempting alternative
      // ("allowed at the staff door if they also hold a staff role") would let an owner keep /login
      // simply by being granted TEACHER, and the boundary would evaporate.
      const res = await post('/auth/login', { email: dualEmail, password });
      expect(res.status).toBe(401);
    });
  });
});
