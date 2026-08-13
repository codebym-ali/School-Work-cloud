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

/**
 * The per-campus admission seat (§8/§23).
 *
 * A campus has exactly ONE admission officer, and that officer must belong to the campus.
 * Before this, ADMISSION_CONTROLLER was a plain capability: any number could hold a campus,
 * and one with NO campus was treated as school-wide — so granting it to a campus-less
 * employee silently handed them every campus's admissions. These cases pin down the seat
 * model: campus compulsory, one holder, handover as a single action, and no admit-anywhere.
 */
describe('Admission officer — the per-campus seat (e2e)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let ownerCookies: string[];
  let campusA: string;
  let campusB: string;
  let teacherA1: string;
  let teacherA2: string;
  let teacherB: string;
  let floater: string; // an employee with NO campus

  const sub = `aof-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@aof.pk', password: 'Owner!Secret12' };

  const server = () => app.getHttpServer();
  const login = async (email: string, password: string) => {
    const res = await loginRequest(server(), host, email, password);
    return { status: res.status, cookies: res.headers['set-cookie'] as unknown as string[] };
  };
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const send = (method: 'post' | 'patch' | 'put' | 'delete', p: string, b: object, cookies: string[]) =>
    request(server())[method](p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send(b);
  const get = (p: string, cookies: string[]) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

  const makeUser = async (email: string, campusId: string | null) => {
    const res = await send(
      'post',
      '/api/v1/users',
      { email, roles: ['TEACHER'], password: 'Teacher!Secret12', ...(campusId ? { campusId } : {}) },
      ownerCookies,
    );
    return res.body.id as string;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const provisioning = app.get(ProvisioningService, { strict: false });
    const prov = await provisioning.provisionSchool({ name: 'AOF School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;
    campusA = prov.campusId;

    ownerCookies = (await login(owner.email, owner.password)).cookies;
    campusB = (await send('post', '/api/v1/campuses', { name: 'Campus B' }, ownerCookies)).body.id;

    teacherA1 = await makeUser('a1@aof.pk', campusA);
    teacherA2 = await makeUser('a2@aof.pk', campusA);
    teacherB = await makeUser('b1@aof.pk', campusB);

    // POST /users forces a campus, so a campus-less employee is made directly — this is the
    // legacy/misconfigured shape the grant path must refuse.
    const f = await platform.user.create({
      data: { schoolId, email: 'floater@aof.pk', roles: ['TEACHER'] as never, status: 'ACTIVE' },
    });
    floater = f.id;
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('starts with every campus vacant, and assigning fills exactly one seat', async () => {
    const before = await get('/api/v1/admission-officers', ownerCookies);
    expect(before.status).toBe(200);
    expect(before.body).toHaveLength(2);
    expect(before.body.every((c: { officer: unknown }) => c.officer === null)).toBe(true);

    const assign = await send('put', `/api/v1/admission-officers/${campusA}`, { userId: teacherA1 }, ownerCookies);
    expect(assign.status).toBe(200);
    expect(assign.body.officer.email).toBe('a1@aof.pk');
    expect(assign.body.previous).toBeNull();

    const after = await get('/api/v1/admission-officers', ownerCookies);
    const a = after.body.find((c: { campusId: string }) => c.campusId === campusA);
    const b = after.body.find((c: { campusId: string }) => c.campusId === campusB);
    expect(a.officer.email).toBe('a1@aof.pk');
    expect(b.officer).toBeNull(); // the other campus is untouched
  });

  it('refuses a SECOND officer on the same campus, via the capability grant', async () => {
    // The seat is held by teacherA1 (previous case). Granting the role to another employee
    // of the same campus is the old way in — it must now 409.
    const res = await send('patch', `/api/v1/users/${teacherA2}/access`, { role: 'ADMISSION_CONTROLLER', grant: true }, ownerCookies);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already has an admission officer/i);

    // And the seat is unchanged — a refused attempt must not half-apply.
    const list = await get('/api/v1/admission-officers', ownerCookies);
    expect(list.body.find((c: { campusId: string }) => c.campusId === campusA).officer.email).toBe('a1@aof.pk');
  });

  it('refuses an employee with no campus — the old silent "school-wide" grant', async () => {
    const res = await send('patch', `/api/v1/users/${floater}/access`, { role: 'ADMISSION_CONTROLLER', grant: true }, ownerCookies);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/not bound to a campus/i);
  });

  it('refuses someone from another campus taking this campus\'s seat', async () => {
    const res = await send('put', `/api/v1/admission-officers/${campusA}`, { userId: teacherB }, ownerCookies);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/does not belong to/i);
  });

  it('hands the seat over in ONE action — old holder loses it, new holder gains it, audited', async () => {
    const res = await send('put', `/api/v1/admission-officers/${campusA}`, { userId: teacherA2 }, ownerCookies);
    expect(res.status).toBe(200);
    expect(res.body.officer.email).toBe('a2@aof.pk');
    expect(res.body.previous.email).toBe('a1@aof.pk'); // the handover names both parties

    // Exactly one holder afterwards — the outgoing one really lost the role, so the seat
    // never ends up doubly held even though both states existed inside one request.
    const holders = await platform.user.findMany({
      where: { schoolId, campusId: campusA, deletedAt: null, roles: { has: 'ADMISSION_CONTROLLER' } },
      select: { email: true },
    });
    expect(holders.map((h) => h.email)).toEqual(['a2@aof.pk']);

    // The outgoing holder keeps their login and their other roles — losing the seat is not
    // losing the job.
    const outgoing = await platform.user.findFirst({ where: { id: teacherA1 }, select: { roles: true, status: true } });
    expect(outgoing?.roles).toContain('TEACHER');
    expect(outgoing?.status).toBe('ACTIVE');

    const audit = await platform.auditLog.findFirst({
      where: { schoolId, action: 'ADMISSION_OFFICER_ASSIGNED', entityId: teacherA2 },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    // Identity, not ids — the trail must stay readable after an account is gone.
    expect(JSON.stringify(audit?.oldValue)).toContain('a1@aof.pk');
    expect(JSON.stringify(audit?.newValue)).toContain('a2@aof.pk');
  });

  it('an officer cannot admit into another campus (no more admit-anywhere)', async () => {
    // teacherA2 holds campus A's seat. Build a class+section in campus B and try to admit there.
    const yr = await send('post', '/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true }, ownerCookies);
    expect(yr.status).toBe(201);
    const klass = await send('post', '/api/v1/classes', { campusId: campusB, name: 'B-Grade', order: 1 }, ownerCookies);
    const section = await send('post', '/api/v1/sections', { classId: klass.body.id, name: 'B' }, ownerCookies);

    const officer = (await login('a2@aof.pk', 'Teacher!Secret12')).cookies;
    const res = await send(
      'post',
      '/api/v1/students',
      {
        fullName: 'Cross Campus', gender: 'MALE', dateOfBirth: '2016-03-03',
        campusId: campusB, classId: klass.body.id, sectionId: section.body.id,
        guardian: { mode: 'CREATE', fullName: 'G X', phone: '03009990001', relation: 'FATHER' },
      },
      officer,
    );
    expect(res.status).toBe(403);
  });

  it('vacating frees the seat so it can be filled again', async () => {
    const del = await send('delete', `/api/v1/admission-officers/${campusA}`, {}, ownerCookies);
    expect(del.status).toBe(200);
    expect(del.body.officer).toBeNull();

    const list = await get('/api/v1/admission-officers', ownerCookies);
    expect(list.body.find((c: { campusId: string }) => c.campusId === campusA).officer).toBeNull();

    // Re-assignable immediately — a departed officer must not lock the campus out for ever.
    const again = await send('put', `/api/v1/admission-officers/${campusA}`, { userId: teacherA1 }, ownerCookies);
    expect(again.status).toBe(200);
    expect(again.body.officer.email).toBe('a1@aof.pk');
  });
});
