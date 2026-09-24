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

const NIL = '00000000-0000-0000-0000-000000000000';

/**
 * Prisma-error fuzz (QA plan C3) — WS-A's "definition of done". WS-A made the global filter translate any
 * stray Prisma error to a clean 4xx; it was proven on two models. This fires SCHEMA-VALID-but-illegal writes
 * across many models — a duplicate unique tuple, a dangling FK, a CHECK/cross-field violation — and asserts
 * every one degrades to a clean client error in the §25.1 envelope (a stable `error.code`), **never a 500 and
 * never a leaked stack**. A missed service pre-check on any model would surface here as a 500.
 */
describe('Prisma-error fuzz — no illegal write is ever a 500 (e2e, §25.1 / WS-A)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let csrf: string;
  const host = `fuzz-${randomUUID().slice(0, 6)}.localhost`;
  const email = 'owner@fuzz.pk';
  const password = 'Owner!Secret12';

  const ctx: Record<string, string> = {};

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const send = (method: 'post' | 'patch' | 'put', p: string, body: object) =>
    request(server())[method](p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).set('Idempotency-Key', randomUUID()).send(body);
  const post = (p: string, body: object = {}) => send('post', p, body);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    platform = app.get(PlatformPrismaService);

    const prov = await app.get(ProvisioningService, { strict: false }).provisionSchool({ name: 'Fuzz School', subdomain: host.split('.')[0], ownerEmail: email, ownerPassword: password });
    schoolId = prov.schoolId;
    ctx.campusId = prov.campusId;
    cookies = (await loginRequest(server(), host, email, password)).headers['set-cookie'] as unknown as string[];
    csrf = csrfOf(cookies);

    ctx.yearId = (await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true })).body.id;
    ctx.classId = (await post('/api/v1/classes', { campusId: ctx.campusId, name: 'Grade 1', order: 1 })).body.id;
    ctx.sectionId = (await post('/api/v1/sections', { classId: ctx.classId, name: 'A' })).body.id;
    await post('/api/v1/subjects', { classId: ctx.classId, name: 'Math' });
    const { admit } = await admissionController(app, platform, schoolId, host, ctx.campusId);
    ctx.studentId = (await admit({
      fullName: 'Fuzz Child', gender: 'MALE', dateOfBirth: '2018-05-10', campusId: ctx.campusId, classId: ctx.classId, sectionId: ctx.sectionId,
      guardian: { mode: 'CREATE', fullName: 'Fuzz Guardian', phone: '03007654321', relation: 'FATHER' },
    })).body.studentId;
    const head = await post('/api/v1/fee-heads', { name: 'Tuition' });
    ctx.feeHeadId = head.body.id;
  }, 120_000);

  afterAll(async () => {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    if (schoolId) await destroyTenant(platform, schoolId);
    await app.close();
  });

  // Each case is a schema-valid but ILLEGAL write. `expect` narrows where the exact status is contractual;
  // otherwise the guarantee is "a clean 4xx in the envelope, never a 500".
  interface Case { label: string; run: () => request.Test; expect?: number }
  const cases: Case[] = [
    // ── Unique violations (P2002) — some via a service pre-check (409), some via the filter floor ──
    { label: 'duplicate academic-year name (filter P2002 → 409)', expect: 409, run: () => post('/api/v1/academic-years', { name: '2026-27', startDate: '2030-04-01', endDate: '2031-03-31' }) },
    { label: 'duplicate class name in a campus', expect: 409, run: () => post('/api/v1/classes', { campusId: ctx.campusId, name: 'Grade 1', order: 1 }) },
    { label: 'duplicate section name in a class', expect: 409, run: () => post('/api/v1/sections', { classId: ctx.classId, name: 'A' }) },
    { label: 'duplicate subject name in a class', expect: 409, run: () => post('/api/v1/subjects', { classId: ctx.classId, name: 'Math' }) },
    { label: 'duplicate fee-head name', run: () => post('/api/v1/fee-heads', { name: 'Tuition' }) },
    // ── Dangling foreign keys (P2003) or a pre-check 404 — either way a clean 4xx ──
    { label: 'class with a non-existent campus', run: () => post('/api/v1/classes', { campusId: NIL, name: 'Ghost', order: 9 }) },
    { label: 'section under a non-existent class', run: () => post('/api/v1/sections', { classId: NIL, name: 'Z' }) },
    { label: 'subject under a non-existent class', run: () => post('/api/v1/subjects', { classId: NIL, name: 'Ghost' }) },
    { label: 'fee-structure with a dangling class + fee head', run: () => post('/api/v1/fee-structures', { campusId: ctx.campusId, classId: NIL, feeHeadId: NIL, academicYearId: ctx.yearId, amount: 500, frequency: 'MONTHLY' }) },
    { label: 'exam under a non-existent term', run: () => post('/api/v1/exams', { termId: NIL, classId: ctx.classId, name: 'Ghost', examType: 'MID_TERM', weightagePercent: 100, examDate: '2026-07-01' }) },
    { label: 'teacher-assignment with dangling staff/section/subject', run: () => post('/api/v1/teacher-assignments', { staffId: NIL, academicYearId: ctx.yearId, sectionId: NIL, subjectId: NIL }) },
    { label: 'invoice batch for a non-existent class', run: () => post('/api/v1/fees/invoice-batches', { classId: NIL, month: 7, year: 2026 }) },
    // ── CHECK / cross-field violations → 422 ──
    { label: 'academic year ending before it starts (422)', expect: 422, run: () => post('/api/v1/academic-years', { name: 'Backwards', startDate: '2029-04-01', endDate: '2028-03-31' }) },
    { label: 'withdraw with a leaving date before admission (422)', expect: 422, run: () => post(`/api/v1/students/${ctx.studentId}/withdraw`, { reason: 'x', leavingDate: '2000-01-01' }) },
    { label: 'student into a section that is not in the chosen class', run: () => post('/api/v1/students', { fullName: 'Bad', gender: 'MALE', dateOfBirth: '2018-01-01', campusId: ctx.campusId, classId: ctx.classId, sectionId: NIL, guardian: { mode: 'CREATE', fullName: 'G', phone: '03001112222', relation: 'FATHER' } }) },
  ];

  for (const c of cases) {
    it(`${c.label} → clean 4xx, never 500`, async () => {
      const res = await c.run();
      // The core WS-A invariant: never a 500, never an unwrapped error.
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(typeof res.body?.error?.code).toBe('string');
      if (c.expect) expect(res.status).toBe(c.expect);
    });
  }
});
