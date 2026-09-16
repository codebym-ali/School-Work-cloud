import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { destroyTenant } from './support/tenant';
import { loginRequest } from './support/login';
import { enrolMfa } from './support/mfa';

/**
 * Users & roles (§23, §22.8): the owner provisions a campus-admin login bound to a campus,
 * that account can actually sign in, and a campus admin cannot escalate (grant OWNER_ADMIN)
 * or reach another campus.
 */
describe('Users & roles (e2e, §23)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let ownerCookies: string[];
  let campusAId: string;
  let campusBId: string;

  const sub = `usr-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@usr.pk', password: 'Owner!Secret12' };
  const campusAdmin = { email: 'ca@usr.pk', password: 'Campus!Secret12' };

  const server = () => app.getHttpServer();
  const login = async (email: string, password: string) => {
    const res = await loginRequest(server(), host, email, password);
    return { status: res.status, cookies: res.headers['set-cookie'] as unknown as string[] };
  };
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object, cookies: string[]) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send(b);
  const patch = (p: string, b: object, cookies: string[]) =>
    request(server()).patch(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send(b);
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
    const prov = await provisioning.provisionSchool({ name: 'Usr School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;
    campusAId = prov.campusId;

    // Enrolled: this spec does two-factor-gated work as the owner (see support/mfa.ts).
    ownerCookies = await enrolMfa(server(), host, (await login(owner.email, owner.password)).cookies);
    const campusB = await post('/api/v1/campuses', { name: 'Second Campus' }, ownerCookies);
    campusBId = campusB.body.id;
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('owner creates a CAMPUS_ADMIN bound to a campus — and that account can sign in', async () => {
    const res = await post('/api/v1/users', { email: campusAdmin.email, roles: ['CAMPUS_ADMIN'], campusId: campusAId, password: campusAdmin.password }, ownerCookies);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: campusAdmin.email, campusId: campusAId, status: 'ACTIVE' });
    expect(res.body.roles).toEqual(['CAMPUS_ADMIN']);

    // The whole point: the new credential actually works.
    const signIn = await login(campusAdmin.email, campusAdmin.password);
    expect(signIn.status).toBe(200);
  });

  it('rejects OWNER_ADMIN with a campus (422) and a duplicate email (409)', async () => {
    const withCampus = await post('/api/v1/users', { email: 'o2@usr.pk', roles: ['OWNER_ADMIN'], campusId: campusAId, password: 'Another!Secret12' }, ownerCookies);
    expect(withCampus.status).toBe(422);

    const dup = await post('/api/v1/users', { email: campusAdmin.email, roles: ['TEACHER'], campusId: campusAId, password: 'Another!Secret12' }, ownerCookies);
    expect(dup.status).toBe(409);
  });

  it('a campus admin cannot escalate (grant OWNER_ADMIN) and is forced to their own campus', async () => {
    const caCookies = (await login(campusAdmin.email, campusAdmin.password)).cookies;

    // Cannot grant an admin role above their own.
    const escalate = await post('/api/v1/users', { email: 'hack@usr.pk', roles: ['OWNER_ADMIN'], password: 'Another!Secret12' }, caCookies);
    expect(escalate.status).toBe(403);

    // Can create a TEACHER — but even if they name campus B, it's forced to their campus A.
    const teacher = await post('/api/v1/users', { email: 'tch@usr.pk', roles: ['TEACHER'], campusId: campusBId, password: 'Another!Secret12' }, caCookies);
    expect(teacher.status).toBe(201);
    expect(teacher.body.campusId).toBe(campusAId);
  });

  it('allows at most one campus admin per campus', async () => {
    const second = await post('/api/v1/users', { email: 'ca2@usr.pk', roles: ['CAMPUS_ADMIN'], campusId: campusAId, password: 'Another!Secret12' }, ownerCookies);
    expect(second.status).toBe(409);

    const otherCampus = await post('/api/v1/users', { email: 'cb@usr.pk', roles: ['CAMPUS_ADMIN'], campusId: campusBId, password: 'Another!Secret12' }, ownerCookies);
    expect(otherCampus.status).toBe(201);

    const emp = await post('/api/v1/users', { email: 'emp-a@usr.pk', roles: ['TEACHER'], campusId: campusAId, password: 'Another!Secret12' }, ownerCookies);
    expect(emp.status).toBe(201);
    const grant = await patch(`/api/v1/users/${emp.body.id}/access`, { role: 'CAMPUS_ADMIN', grant: true }, ownerCookies);
    expect(grant.status).toBe(409);
  });

  it('allows at most one accountant per campus', async () => {
    // Operator instruction 2026-08-12: the accountant is a campus SEAT, like the principal and the
    // admission officer. One person per campus reconciles the drawer, so a shortfall has one name
    // against it. Costed and accepted: only OWNER_ADMIN and ACCOUNTANT may take a payment, so this
    // leaves a campus with exactly one non-owner cashier.
    const first = await post('/api/v1/users', { email: 'acc-a@usr.pk', roles: ['ACCOUNTANT'], campusId: campusAId, password: 'Another!Secret12' }, ownerCookies);
    expect(first.status).toBe(201);

    const second = await post('/api/v1/users', { email: 'acc-a2@usr.pk', roles: ['ACCOUNTANT'], campusId: campusAId, password: 'Another!Secret12' }, ownerCookies);
    expect(second.status).toBe(409);
    // Names the incumbent and the remedy — and names the right ROLE. The message used to be a
    // ternary that called anything other than an admission officer "a campus admin".
    expect(second.body.error.message).toMatch(/already has an accountant/i);
    expect(second.body.error.message).toContain('acc-a@usr.pk');

    // ⚠️ The rule is one per CAMPUS, not one per school — without this case a filter that ignored
    // the campus entirely would pass every other assertion here.
    const otherCampus = await post('/api/v1/users', { email: 'acc-b@usr.pk', roles: ['ACCOUNTANT'], campusId: campusBId, password: 'Another!Secret12' }, ownerCookies);
    expect(otherCampus.status).toBe(201);

    // The capability grant is the other way in: an existing employee of campus A promoted to
    // accountant must hit the same seat check, not just the create path.
    const emp = await post('/api/v1/users', { email: 'emp-acc@usr.pk', roles: ['TEACHER'], campusId: campusAId, password: 'Another!Secret12' }, ownerCookies);
    expect(emp.status).toBe(201);
    const grant = await patch(`/api/v1/users/${emp.body.id}/access`, { role: 'ACCOUNTANT', grant: true }, ownerCookies);
    expect(grant.status).toBe(409);

    // ⚠️ **The service check is not what makes this safe — it is what makes it civil.** Probed by
    // removing ACCOUNTANT from `SOLE_CAMPUS_SEAT_ROLES`: this case still failed, but with **500**
    // rather than 201, because the partial unique index in `02_partial_uniques.sql` refuses the row
    // regardless. The index is the backstop under a race (a check is read-then-write, so two owners
    // assigning at the same moment both pass it); the service check is what turns that into a 409
    // naming the incumbent instead of a stack trace.

    // A refused attempt must not half-apply: the employee is still only a teacher.
    const after = await get(`/api/v1/users`, ownerCookies);
    const row = (after.body.data ?? after.body).find((u: { email: string }) => u.email === 'emp-acc@usr.pk');
    expect(row.roles).toEqual(['TEACHER']);
  });

  it('lists users; owner reset-password works', async () => {
    const list = await get('/api/v1/users', ownerCookies);
    expect(list.status).toBe(200);
    const emails = list.body.map((u: { email: string }) => u.email);
    expect(emails).toEqual(expect.arrayContaining([owner.email, campusAdmin.email]));

    const target = list.body.find((u: { email: string }) => u.email === campusAdmin.email);
    const reset = await post(`/api/v1/users/${target.id}/reset-password`, { password: 'Rotated!Secret12' }, ownerCookies);
    expect(reset.status).toBe(201);
    expect((await login(campusAdmin.email, 'Rotated!Secret12')).status).toBe(200);
  });
});
