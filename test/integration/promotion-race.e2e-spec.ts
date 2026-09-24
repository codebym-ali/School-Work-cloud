import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { SMS_QUEUE } from '../../apps/api/src/modules/comms/sms/sms.types';
import { admissionController } from './support/admission';
import { destroyTenant } from './support/tenant';
import { loginRequest } from './support/login';

/**
 * Promotion / year-rollover race (QA plan §2). Promotion is a bulk, irreversible, cross-year write — the
 * scariest untested path. Its safety rests on the partial unique index (one ACTIVE enrolment per student per
 * year): two commits of the same reviewed plan both see the students unplaced, but the DB lets exactly one
 * createMany win and refuses the second (P2002 → 409). This asserts that end to end:
 *   • two concurrent commits → exactly one 200, one 409 "already committed" — never two, never a 500;
 *   • the target year ends with N active enrolments, not 2N (no doubling);
 *   • a commit whose fingerprint is stale (state changed since preview) → 409, not a silent re-run.
 */
describe('Promotion race — concurrent commits are exactly-once (e2e, §7)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let csrf: string;
  let campusId: string;
  let targetYearId: string;
  const N = 4;
  const host = `promo-${randomUUID().slice(0, 6)}.localhost`;
  const email = 'owner@promo.pk';
  const password = 'Owner!Secret12';

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, body: object = {}) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).set('Idempotency-Key', randomUUID()).send(body);
  const activeInTarget = () =>
    platform.studentEnrollment.count({ where: { schoolId, academicYearId: targetYearId, status: 'ACTIVE' } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    platform = app.get(PlatformPrismaService);

    const prov = await app.get(ProvisioningService, { strict: false }).provisionSchool({ name: 'Promo School', subdomain: host.split('.')[0], ownerEmail: email, ownerPassword: password });
    schoolId = prov.schoolId;
    campusId = prov.campusId;
    cookies = (await loginRequest(server(), host, email, password)).headers['set-cookie'] as unknown as string[];
    csrf = csrfOf(cookies);

    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    targetYearId = (await post('/api/v1/academic-years', { name: '2027-28', startDate: '2027-04-01', endDate: '2028-03-31' })).body.id;

    // Two grades so grade-1 students PROMOTE (move) into grade-2, exercising the createMany the index guards.
    const g1 = (await post('/api/v1/classes', { campusId, name: 'Grade 1', order: 1 })).body.id;
    const g2 = (await post('/api/v1/classes', { campusId, name: 'Grade 2', order: 2 })).body.id;
    const g1secA = (await post('/api/v1/sections', { classId: g1, name: 'A' })).body.id; // admit into
    await post('/api/v1/sections', { classId: g2, name: 'A' }); // promote into

    const { admit } = await admissionController(app, platform, schoolId, host, campusId);
    for (let i = 0; i < N; i++) {
      const res = await admit({
        fullName: `Promo Child ${i}`, gender: 'MALE', dateOfBirth: '2018-05-10', campusId, classId: g1, sectionId: g1secA,
        guardian: { mode: 'CREATE', fullName: `G ${i}`, phone: `0300700000${i}`, relation: 'FATHER' },
      });
      expect(res.status).toBe(201);
    }
  }, 120_000);

  afterAll(async () => {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    if (schoolId) await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('two concurrent commits of the same plan → exactly one 200, one 409, and no doubling', async () => {
    const plan = await post('/api/v1/promotions/plan', { targetYearId, campusId });
    expect(plan.status).toBe(200);
    const fingerprint = plan.body.fingerprint;
    expect(fingerprint).toBeTruthy();
    expect(await activeInTarget()).toBe(0);

    const [a, b] = await Promise.all([
      post('/api/v1/promotions/commit', { targetYearId, campusId, fingerprint }),
      post('/api/v1/promotions/commit', { targetYearId, campusId, fingerprint }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]); // one wins, one is cleanly refused
    const conflict = [a, b].find((r) => r.status === 409)!;
    expect(conflict.body.error.code).toBe('CONFLICT');

    // The whole cohort is promoted exactly once — N active in the new year, not 2N.
    expect(await activeInTarget()).toBe(N);
  }, 60_000);

  it('a commit with a stale fingerprint (state changed since preview) is refused with 409', async () => {
    // The state already changed (the cohort was promoted above), so a plan captured "before" no longer
    // matches. Simulate a stale review by committing a bogus fingerprint: the build no longer equals it.
    const res = await post('/api/v1/promotions/commit', { targetYearId, campusId, fingerprint: 'stale-fingerprint-000' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    // Nothing changed — still exactly N.
    expect(await activeInTarget()).toBe(N);
  }, 60_000);
});
