import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { admissionController } from './support/admission';
import { SMS_QUEUE } from '../../apps/api/src/modules/comms/sms/sms.types';
import { destroyTenant } from './support/tenant';

/**
 * Guardian-of-student ownership (blueprint §22.8, playbook P1.7). A PARENT is confined
 * to their own children: report-card reads and student-leave create/list for another
 * family are denied (deny-by-default), while OWNER_ADMIN is unrestricted (no regression).
 */
describe('Guardian ownership (e2e, §22.8 / P1.7)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;

  let ownerCookies: string[];
  let ownerCsrf: string;
  let parentCookies: string[];
  let parentCsrf: string;

  let student1: string; // parent's own child
  let student2: string; // another family's child

  const sub = `own-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const email = 'owner@own.pk';
  const password = 'Owner!Secret12';
  const parentEmail = 'parent1@own.pk';
  const parentPassword = 'Parent!Secret12';

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const authed = (method: 'get' | 'post', p: string, cookies: string[], csrf?: string) => {
    let r = request(server())[method](p).set('Host', host).set('Cookie', cookies);
    if (csrf) r = r.set('X-CSRF-Token', csrf);
    return r;
  };
  const ownerPost = (p: string, b: object = {}) => authed('post', p, ownerCookies, ownerCsrf).send(b);
  const login = async (e: string, pw: string) => {
    const res = await request(server()).post('/api/v1/auth/login').set('Host', host).send({ email: e, password: pw });
    return res.headers['set-cookie'] as unknown as string[];
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
    const prov = await provisioning.provisionSchool({ name: 'Own School', subdomain: sub, ownerEmail: email, ownerPassword: password });
    schoolId = prov.schoolId;
    const campusId = prov.campusId;

    ownerCookies = await login(email, password);
    ownerCsrf = csrfOf(ownerCookies);

    await ownerPost('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    const classId = (await ownerPost('/api/v1/classes', { campusId, name: 'Grade 1', order: 1 })).body.id;
    const sectionId = (await ownerPost('/api/v1/sections', { classId, name: 'A' })).body.id;

    const { admit } = await admissionController(app, platform, schoolId, host);
    const mkStudent = async (name: string, phone: string) =>
      (await admit({
        fullName: name, gender: 'MALE', dateOfBirth: '2016-01-10', campusId, classId, sectionId,
        guardian: { mode: 'CREATE', fullName: `G ${name}`, phone, relation: 'FATHER' },
      })).body.studentId;
    student1 = await mkStudent('Child One', '03001110001');
    student2 = await mkStudent('Child Two', '03002220002');

    // Seed a real PARENT (ACTIVE, with a password) linked to student1 only.
    const parentUser = await platform.user.create({
      data: { schoolId, email: parentEmail, roles: ['PARENT'], status: 'ACTIVE', passwordHash: await argon2.hash(parentPassword, { type: argon2.argon2id }) },
    });
    const parentProfile = await platform.parentProfile.create({
      data: { schoolId, userId: parentUser.id, fullName: 'Parent One', phone: '+923009990009' },
    });
    await platform.studentGuardian.create({
      data: { schoolId, studentId: student1, parentId: parentProfile.id, relation: 'FATHER', isPrimary: false },
    });

    parentCookies = await login(parentEmail, parentPassword);
    parentCsrf = csrfOf(parentCookies);

    // A leave for the OTHER family's child, so the parent's list must not include it.
    await ownerPost('/api/v1/student-leaves', { studentId: student2, fromDate: '2026-08-01', toDate: '2026-08-02', reason: 'x' });
  });

  afterAll(async () => {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  // ── After the parent-portal removal (2026-07-28) ────────────────────────────
  // These were the GuardianOfStudent tests. Parents have no logins and no portal, so the
  // property under test is no longer "a parent sees only their own child" — it is
  // "a non-admin sees nothing". The routes below carry NO @Roles, so these in-service
  // guards are the only protection and are worth asserting harder than before.

  it('denies a non-admin the admin report-card surface entirely', async () => {
    // Was: parent 200 for their own child, 403 for another's. Now: denied for both.
    expect((await authed('get', `/api/v1/students/${student1}/report-cards`, parentCookies)).status).toBe(403);
    const cross = await authed('get', `/api/v1/students/${student2}/report-cards`, parentCookies);
    expect(cross.status).toBe(403);
    expect(cross.body.error.code).toBe('FORBIDDEN');
  });

  it('OWNER_ADMIN can still read any student’s report cards (no regression)', async () => {
    expect((await authed('get', `/api/v1/students/${student2}/report-cards`, ownerCookies)).status).toBe(200);
  });

  it('student-leaves list leaks nothing to a non-admin', async () => {
    // GET /student-leaves has no @Roles; the in-service filter must return an empty set
    // rather than every leave in the school.
    const res = await authed('get', '/api/v1/student-leaves', parentCookies);
    expect(res.status).toBe(200);
    const studentIds = (res.body.data as Array<{ studentId: string }>).map((l) => l.studentId);
    expect(studentIds).not.toContain(student1);
    expect(studentIds).not.toContain(student2);
  });

  it('a non-admin can no longer file a student leave (403)', async () => {
    // PARENT was removed from @Roles on POST /student-leaves — filing is now staff-only.
    for (const sid of [student1, student2]) {
      const res = await authed('post', '/api/v1/student-leaves', parentCookies, parentCsrf)
        .send({ studentId: sid, fromDate: '2026-09-01', toDate: '2026-09-02', reason: 'x' });
      expect(res.status).toBe(403);
    }
  });

  // Regression guard: the portal must stay gone. If someone reinstates the controller these
  // flip to 401/403/200 and this fails loudly.
  it('the parent portal routes no longer exist (404)', async () => {
    expect((await authed('get', '/api/v1/parent/children', parentCookies)).status).toBe(404);
    for (const sub of ['overview', 'attendance', 'results', 'fees']) {
      expect((await authed('get', `/api/v1/parent/children/${student1}/${sub}`, parentCookies)).status).toBe(404);
    }
    expect((await authed('get', '/api/v1/parent/children', ownerCookies)).status).toBe(404);
  });
});
