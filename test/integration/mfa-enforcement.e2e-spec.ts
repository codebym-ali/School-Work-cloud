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
 * Two-factor is ENFORCED on sensitive routes for the roles that must have it (plan item 0.2, D1).
 *
 * ⚠️ Until 2026-09-16 "Two-factor authentication is required for your role" was a red banner and
 * nothing else. These cases pin what replaced it — including the parts that are easy to get wrong in
 * the OTHER direction: routine work stays open, a non-mandatory role is unaffected, and enrolment
 * takes effect in the SAME session rather than up to fifteen minutes later.
 *
 * Enrolment is done by hand here rather than through support/mfa.ts, so setup, verify and disable are
 * each asserted instead of hidden inside a helper. Cases run in order and share the owner session.
 */
describe('Two-factor enforcement (e2e, plan 0.2)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let campusId: string;
  let ownerCookies: string[];
  let ownerSecret: string;
  let targetId: string;

  const sub = `mfa-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@mfae.pk', password: 'Owner!Secret12' };
  const campusAdmin = { email: 'ca@mfae.pk', password: 'Campus!Secret12' };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const send = (method: 'post' | 'patch' | 'delete', p: string, b: object, cookies: string[]) =>
    request(server())[method](p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send(b);

  /** Adopt the access cookie a response just set, exactly as a browser would. */
  const adopt = (cookies: string[], res: request.Response): string[] => {
    const fresh = (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith('access_token='));
    return fresh ? [...cookies.filter((c) => !c.startsWith('access_token=')), fresh] : cookies;
  };

  /** A sensitive action every case can repeat: resetting another user's password. */
  const resetTarget = (cookies: string[]) =>
    send('post', `/api/v1/users/${targetId}/reset-password`, { password: `Reset!${Date.now()}Aa` }, cookies);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    platform = app.get(PlatformPrismaService);

    const prov = await app
      .get(ProvisioningService, { strict: false })
      .provisionSchool({ name: 'MFA School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;
    campusId = prov.campusId;

    const login = await loginRequest(server(), host, owner.email, owner.password);
    ownerCookies = login.headers['set-cookie'] as unknown as string[];
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('leaves routine work open to an unenrolled owner', async () => {
    // Creating a user is onboarding, not a correction or a disclosure. Gating it would stop a school
    // setting itself up on day one — the "do not over-enforce" half of the policy.
    const created = await send(
      'post', '/api/v1/users',
      { email: 'target@mfae.pk', roles: ['TEACHER'], campusId, password: 'Teach!Secret12' },
      ownerCookies,
    );
    expect(created.status).toBe(201);
    targetId = created.body.id;
  });

  it('refuses an unenrolled owner a sensitive action, with its own error code', async () => {
    const res = await resetTarget(ownerCookies);
    expect(res.status).toBe(403);
    // Distinct from FORBIDDEN, so the client can send the person to Security rather than tell them
    // they lack a permission they in fact hold.
    expect(res.body.error.code).toBe('MFA_ENROLMENT_REQUIRED');
  });

  it('takes effect in the SAME session the moment enrolment completes', async () => {
    const setup = await send('post', '/api/v1/auth/mfa/setup', {}, ownerCookies);
    expect(setup.status).toBe(201);
    ownerCookies = adopt(ownerCookies, setup);
    ownerSecret = new URL(setup.body.otpauthUrl).searchParams.get('secret')!;

    const verify = await send('post', '/api/v1/auth/mfa/verify', { code: authenticator.generate(ownerSecret) }, ownerCookies);
    expect(verify.status).toBe(200);
    // ⚠️ The re-signed cookie IS the mechanism. Without it the token keeps `mfa: false` for up to
    // JWT_ACCESS_TTL, and an owner who has just enrolled is told to enrol.
    expect((verify.headers['set-cookie'] as unknown as string[]).some((c) => c.startsWith('access_token='))).toBe(true);
    ownerCookies = adopt(ownerCookies, verify);

    expect((await resetTarget(ownerCookies)).status).toBe(201);
  });

  it('locks it again in the same session when two-factor is switched off', async () => {
    // The mirror case: a token must not keep vouching for a second factor that no longer exists.
    const off = await send(
      'delete', '/api/v1/auth/mfa',
      { password: owner.password, code: authenticator.generate(ownerSecret) },
      ownerCookies,
    );
    expect(off.status).toBe(204);
    ownerCookies = adopt(ownerCookies, off);

    const res = await resetTarget(ownerCookies);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MFA_ENROLMENT_REQUIRED');
  });

  it('does not touch a role for which two-factor is not mandatory', async () => {
    // A campus admin may reset a password on their campus without enrolling. The guard enforces the
    // existing mandatory-role policy; it must not quietly widen it to everyone.
    //
    // Created straight in the database: the owner is deliberately unenrolled after the previous case,
    // and this case is about the campus admin, not about the owner enrolling again.
    const argon2 = await import('argon2');
    await platform.user.create({
      data: {
        schoolId, email: campusAdmin.email, roles: ['CAMPUS_ADMIN'], campusId, status: 'ACTIVE',
        passwordHash: await argon2.hash(campusAdmin.password, { type: argon2.argon2id }),
      },
    });
    const login = await loginRequest(server(), host, campusAdmin.email, campusAdmin.password);
    const caCookies = login.headers['set-cookie'] as unknown as string[];

    expect((await resetTarget(caCookies)).status).toBe(201);
  });
});
