import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { destroyTenant } from './support/tenant';

/**
 * HR access (RBAC): only OWNER_ADMIN may grant the HR_MANAGER role on an EXISTING employee,
 * which unlocks recruitment. Proves the access flips 403 → 200 on grant and back on revoke,
 * that the account is reused (roles preserved, no new login), and that a campus admin cannot
 * grant it.
 */
describe('HR access grant (e2e, RBAC)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let ownerCookies: string[];
  let campusAId: string;
  let campusBId: string;
  let teacherUserId: string;

  const sub = `hra-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@hra.pk', password: 'Owner!Secret12' };
  const campusAdmin = { email: 'ca@hra.pk', password: 'Campus!Secret12' };
  const teacher = { email: 'tch@hra.pk', password: 'Teacher!Secret12' };

  const server = () => app.getHttpServer();
  const login = async (email: string, password: string) => {
    const res = await request(server()).post('/api/v1/auth/login').set('Host', host).send({ email, password });
    return { status: res.status, cookies: res.headers['set-cookie'] as unknown as string[] };
  };
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const send = (method: 'post' | 'patch' | 'delete', p: string, b: object, cookies: string[]) =>
    request(server())[method](p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send(b);
  const get = (p: string, cookies: string[]) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const provisioning = app.get(ProvisioningService, { strict: false });
    const prov = await provisioning.provisionSchool({ name: 'HRA School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;
    campusAId = prov.campusId;

    ownerCookies = (await login(owner.email, owner.password)).cookies;
    campusBId = (await send('post', '/api/v1/campuses', { name: 'Second Campus' }, ownerCookies)).body.id;
    await send('post', '/api/v1/users', { email: campusAdmin.email, roles: ['CAMPUS_ADMIN'], campusId: campusAId, password: campusAdmin.password }, ownerCookies);
    const t = await send('post', '/api/v1/users', { email: teacher.email, roles: ['TEACHER'], campusId: campusBId, password: teacher.password }, ownerCookies);
    teacherUserId = t.body.id;
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('a teacher has no recruitment access until the owner grants it — then loses it on revoke', async () => {
    // Before: the teacher cannot reach recruitment.
    const before = (await login(teacher.email, teacher.password)).cookies;
    expect((await get('/api/v1/vacancies', before)).status).toBe(403);

    // Owner grants HR access — the account is reused, roles preserved + HR_MANAGER added.
    const grant = await send('patch', `/api/v1/users/${teacherUserId}/access`, { role: 'HR_MANAGER', grant: true }, ownerCookies);
    expect(grant.status).toBe(200);
    expect(grant.body.roles).toEqual(expect.arrayContaining(['TEACHER', 'HR_MANAGER']));

    // After: a fresh session for the same teacher can now reach recruitment.
    const after = (await login(teacher.email, teacher.password)).cookies;
    expect((await get('/api/v1/vacancies', after)).status).toBe(200);

    // Revoke removes it again.
    const revoke = await send('patch', `/api/v1/users/${teacherUserId}/access`, { role: 'HR_MANAGER', grant: false }, ownerCookies);
    expect(revoke.status).toBe(200);
    expect(revoke.body.roles).toEqual(['TEACHER']);
    const revoked = (await login(teacher.email, teacher.password)).cookies;
    expect((await get('/api/v1/vacancies', revoked)).status).toBe(403);
  });

  it('owner makes an existing employee a campus admin (principal), then revokes it', async () => {
    // Before: the teacher cannot reach a campus-admin endpoint (user management).
    const before = (await login(teacher.email, teacher.password)).cookies;
    expect((await get('/api/v1/users', before)).status).toBe(403);

    const grant = await send('patch', `/api/v1/users/${teacherUserId}/access`, { role: 'CAMPUS_ADMIN', grant: true }, ownerCookies);
    expect(grant.status).toBe(200);
    expect(grant.body.roles).toEqual(expect.arrayContaining(['TEACHER', 'CAMPUS_ADMIN']));

    const asAdmin = (await login(teacher.email, teacher.password)).cookies;
    expect((await get('/api/v1/users', asAdmin)).status).toBe(200);

    const revoke = await send('patch', `/api/v1/users/${teacherUserId}/access`, { role: 'CAMPUS_ADMIN', grant: false }, ownerCookies);
    expect(revoke.body.roles).toEqual(['TEACHER']);
    const revoked = (await login(teacher.email, teacher.password)).cookies;
    expect((await get('/api/v1/users', revoked)).status).toBe(403);
  });

  it('rejects making a campus-less user (the owner) a campus admin → 422', async () => {
    const me = await get('/api/v1/auth/me', ownerCookies);
    const res = await send('patch', `/api/v1/users/${me.body.id}/access`, { role: 'CAMPUS_ADMIN', grant: true }, ownerCookies);
    expect(res.status).toBe(422);
  });

  it('a campus admin cannot grant HR or campus-admin access (owner-only) → 403', async () => {
    const caCookies = (await login(campusAdmin.email, campusAdmin.password)).cookies;
    expect((await send('patch', `/api/v1/users/${teacherUserId}/access`, { role: 'HR_MANAGER', grant: true }, caCookies)).status).toBe(403);
    expect((await send('patch', `/api/v1/users/${teacherUserId}/access`, { role: 'CAMPUS_ADMIN', grant: true }, caCookies)).status).toBe(403);
  });

  it('writes an audit log for the grant and the revoke', async () => {
    const actions = (await platform.auditLog.findMany({ where: { schoolId, entityId: teacherUserId } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['HR_ACCESS_GRANTED', 'HR_ACCESS_REVOKED']));
  });

  // Audit fix #3: the unique on (school_id, email) is partial (WHERE deleted_at IS NULL),
  // so a REMOVED account no longer owns its address for ever. Before this, re-hiring
  // someone — or reusing a mis-typed address — was impossible with no visible record to clear.
  it("frees a removed teacher's email for reuse", async () => {
    const email = `rehire-${Date.now()}@demo.pk`;
    const first = await send('post', '/api/v1/staff', {
      email, staffType: 'TEACHER', fullName: 'First Hire', employeeCode: `EMP-R${Date.now()}`,
      designation: 'Teacher', joinedAt: '2026-07-01', campusId: campusAId, password: 'Teach!Secret12',
    }, ownerCookies);
    expect(first.status).toBe(201);

    // Still taken while the account is live.
    const clash = await send('post', '/api/v1/staff', {
      email, staffType: 'TEACHER', fullName: 'Clash', employeeCode: `EMP-C${Date.now()}`,
      designation: 'Teacher', joinedAt: '2026-07-01', campusId: campusAId,
    }, ownerCookies);
    expect(clash.status).toBe(409);

    // Remove the account (soft-delete), then the address is free again.
    await send('delete', `/api/v1/users/${first.body.userId}`, {}, ownerCookies);
    const rehired = await send('post', '/api/v1/staff', {
      email, staffType: 'TEACHER', fullName: 'Re-hired', employeeCode: `EMP-N${Date.now()}`,
      designation: 'Teacher', joinedAt: '2026-08-01', campusId: campusAId, password: 'Teach!Secret12',
    }, ownerCookies);
    expect(rehired.status).toBe(201);

    // Both rows coexist: one removed, one live — no duplication of a LIVE address.
    const rows = await platform.user.findMany({ where: { schoolId, email } });
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.deletedAt === null)).toHaveLength(1);

    // …and the re-hired person can actually SIGN IN. Making the email unique only among live
    // rows means an email no longer identifies one user, so every lookup by email must say
    // which one it wants. `auth.login` did not, and an unordered findFirst is free to return
    // the REMOVED row — whereupon the deletedAt guard rejects a perfectly valid password.
    // Re-hiring someone silently locked them out; this asserts it does not.
    const signedIn = await login(email, 'Teach!Secret12');
    expect(signedIn.status).toBe(200);
  });

  // The point of the feature: a teacher added with a password can sign in immediately,
  // rather than sitting INVITED until someone sets one for them in Campus Hub.
  it('a teacher created WITH a password is ACTIVE and can sign in straight away', async () => {
    const email = `instant-${Date.now()}@demo.pk`;
    const password = 'Teach!Secret12';
    const res = await send('post', '/api/v1/staff', {
      email, staffType: 'TEACHER', fullName: 'Instant Teacher', employeeCode: `EMP-${Date.now()}`,
      designation: 'Physics Teacher', joinedAt: '2026-07-01', campusId: campusAId, password,
    }, ownerCookies);
    expect(res.status).toBe(201);
    expect(res.body.loginActive).toBe(true);

    const signedIn = await login(email, password);
    expect(signedIn.status).toBe(200);

    const user = await platform.user.findFirst({ where: { schoolId, email } });
    expect(user?.status).toBe('ACTIVE');
    expect(user?.passwordHash).toBeTruthy();
    expect(user?.passwordChangedAt).not.toBeNull();
  });

  it('a teacher created WITHOUT a password stays INVITED and cannot sign in', async () => {
    const email = `invited-${Date.now()}@demo.pk`;
    const res = await send('post', '/api/v1/staff', {
      email, staffType: 'TEACHER', fullName: 'Invited Teacher', employeeCode: `EMP-B${Date.now()}`,
      designation: 'Maths Teacher', joinedAt: '2026-07-01', campusId: campusAId,
    }, ownerCookies);
    expect(res.status).toBe(201);
    expect(res.body.loginActive).toBe(false);

    const attempt = await login(email, 'Teach!Secret12');
    expect(attempt.status).toBe(401);

    const user = await platform.user.findFirst({ where: { schoolId, email } });
    expect(user?.status).toBe('INVITED');
    expect(user?.passwordHash).toBeNull();
  });
});
