import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { admissionController } from './support/admission';
import { destroyTenant } from './support/tenant';
import { loginRequest } from './support/login';

/**
 * Year-end promotion: preview → commit (GAP-03).
 *
 * Placement rules are unit-tested in `promotion-planner.spec.ts`. These cases pin what only a database can
 * show: preview writes nothing, commit applies exactly the reviewed plan, a plan that went stale is refused
 * with nothing written, and re-running does not move anyone twice.
 *
 * The campus: Grade 1 (order 1), Grade 2 (order 2), Grade 4 (order 4 — Grade 3 does not exist, B3) as the top
 * class. Cases run in order; each builds on the state the one before it left.
 */
describe('Year-end promotion (e2e, GAP-03)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let campusId: string;
  let targetYearId: string;
  let admit: (dto: object) => request.Test;
  const ids: Record<string, string> = {};

  const sub = `prm-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@prm.pk', password: 'Owner!Secret12' };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send(b);

  const student = async (name: string, classId: string, sectionId: string) => {
    const res = await admit({ fullName: name, gender: 'MALE', dateOfBirth: '2012-01-01', campusId, classId, sectionId });
    expect(res.status).toBe(201);
    await platform.studentEnrollment.update({ where: { id: res.body.enrollmentId }, data: { startedAt: new Date('2026-04-01') } });
    return res.body.studentId as string;
  };
  const activeIn = (studentId: string, yearId: string) =>
    platform.studentEnrollment.findFirst({ where: { studentId, academicYearId: yearId, status: 'ACTIVE' }, include: { class: true } });
  const plan = (extra: object = {}) => post('/api/v1/promotions/plan', { targetYearId, campusId, ...extra });
  const lineFor = (body: { sections: Array<{ lines: Array<{ studentId: string }> }> }, studentId: string) =>
    body.sections.flatMap((s) => s.lines).find((l) => l.studentId === studentId) as Record<string, unknown>;

  let currentYearId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    platform = app.get(PlatformPrismaService);

    const prov = await app.get(ProvisioningService, { strict: false })
      .provisionSchool({ name: 'Promotion School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;
    campusId = prov.campusId;
    cookies = (await loginRequest(server(), host, owner.email, owner.password)).headers['set-cookie'] as unknown as string[];

    currentYearId = (await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true })).body.id;
    targetYearId = (await post('/api/v1/academic-years', { name: '2027-28', startDate: '2027-04-01', endDate: '2028-03-31' })).body.id;

    for (const [key, name, order] of [['g1', 'Grade 1', 1], ['g2', 'Grade 2', 2], ['g4', 'Grade 4', 4]] as const) {
      ids[key] = (await post('/api/v1/classes', { campusId, name, order })).body.id;
      ids[`${key}a`] = (await post('/api/v1/sections', { classId: ids[key], name: 'A' })).body.id;
    }
    ({ admit } = await admissionController(app, platform, schoolId, host, campusId));

    ids.ali = await student('Ali', ids.g1, ids.g1a);
    ids.bilal = await student('Bilal', ids.g2, ids.g2a); // will owe
    ids.danish = await student('Danish', ids.g4, ids.g4a); // top class

    // Bilal owes July — begun and unpaid. Clearance is required by default.
    const head = (await post('/api/v1/fee-heads', { name: 'Tuition' })).body.id;
    await post('/api/v1/fee-structures', { campusId, classId: ids.g2, feeHeadId: head, academicYearId: currentYearId, amount: 1500, frequency: 'MONTHLY' });
    expect((await post('/api/v1/fees/invoice-batches', { classId: ids.g2, month: 7, year: 2026 })).status).toBeLessThan(300);
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('previews without writing anything', async () => {
    const before = await platform.studentEnrollment.count({ where: { schoolId } });
    const res = await plan();
    expect(res.status).toBe(200);
    expect(await platform.studentEnrollment.count({ where: { schoolId } })).toBe(before);

    expect(lineFor(res.body, ids.ali)).toMatchObject({ outcome: 'PROMOTED', toLabel: 'Grade 2 A' });
    // B2: the top class completes.
    expect(lineFor(res.body, ids.danish)).toMatchObject({ outcome: 'COMPLETED', blocked: null });
    // Clearance: Bilal owes a begun month.
    expect(lineFor(res.body, ids.bilal)).toMatchObject({ outcome: null, blocked: 'Fees are owed' });
    expect(res.body.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it('B3: promotes Grade 2 into Grade 4 when there is no Grade 3 — once the fees are waived through the override', async () => {
    // The owner may override clearance; Bilal then moves to the next EXISTING class.
    const res = await plan({ overridePreconditions: true });
    expect(lineFor(res.body, ids.bilal)).toMatchObject({ outcome: 'PROMOTED', toLabel: 'Grade 4 A' });
  });

  it('refuses a plan that went stale, and writes nothing', async () => {
    const reviewed = await plan();
    // A new admission lands in Grade 1 after the owner reviewed the list.
    ids.late = await student('Late Arrival', ids.g1, ids.g1a);

    const res = await post('/api/v1/promotions/commit', { targetYearId, campusId, fingerprint: reviewed.body.fingerprint });
    expect(res.status).toBe(409);
    expect(await activeIn(ids.ali, targetYearId)).toBeNull();
  });

  it('commits exactly the reviewed plan', async () => {
    const reviewed = await plan();
    const res = await post('/api/v1/promotions/commit', { targetYearId, campusId, fingerprint: reviewed.body.fingerprint, reason: 'Year end 2027' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ promoted: 2, completed: 1, skipped: 0 });
    expect(res.body.blocked.map((b: { studentId: string }) => b.studentId)).toEqual([ids.bilal]);

    const ali = await activeIn(ids.ali, targetYearId);
    expect(ali?.class.name).toBe('Grade 2');
    expect((await platform.studentEnrollment.findFirstOrThrow({ where: { studentId: ids.ali, academicYearId: currentYearId } })).status).toBe('PROMOTED');

    // Danish completed school: no new-year seat, and no longer an active student.
    expect(await activeIn(ids.danish, targetYearId)).toBeNull();
    expect((await platform.student.findUniqueOrThrow({ where: { id: ids.danish } })).isActive).toBe(false);

    // Bilal was blocked, so nothing about him changed.
    expect((await activeIn(ids.bilal, currentYearId))?.class.name).toBe('Grade 2');

    const audit = await platform.auditLog.findFirst({ where: { schoolId, action: 'PROMOTION_COMMITTED', entityId: targetYearId } });
    expect(audit?.reason).toBe('Year end 2027');
  });

  it('does not move anyone twice when run again', async () => {
    const again = await plan();
    const moved = again.body.sections.flatMap((s: { lines: Array<{ outcome: string | null }> }) => s.lines).filter((l: { outcome: string | null }) => l.outcome === 'PROMOTED' || l.outcome === 'COMPLETED');
    expect(moved).toHaveLength(0);
    expect(await platform.studentEnrollment.count({ where: { studentId: ids.ali, status: 'ACTIVE' } })).toBe(1);
  });

  it('keeps the original single-section route working', async () => {
    const res = await post('/api/v1/promotions', { sectionId: ids.g2a, targetYearId, overridePreconditions: true, reason: 'Owner approved' });
    expect(res.status).toBe(200);
    expect(res.body.promoted).toBe(1);
    expect((await activeIn(ids.bilal, targetYearId))?.class.name).toBe('Grade 4');
  });
});
