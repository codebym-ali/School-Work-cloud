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
 * Plans & entitlement — SA3a (blueprint §24). The plan catalog is a defined, single-source, open
 * read; changing a tenant's plan is a SUPER_ADMIN-only, audited write. SA3a assigns plans; it does
 * NOT enforce the caps on the tenant request path (that is SA3b), so nothing here exercises a limit.
 */
describe('Platform plans & plan assignment (e2e, §24 SA3a)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;

  const HOST = 'admin.localhost';
  const password = 'Operator!Secret12';
  const superEmail = `plans-super-${randomUUID().slice(0, 8)}@platform.pk`;
  const analystEmail = `plans-analyst-${randomUUID().slice(0, 8)}@platform.pk`;
  let superId: string;
  let analystId: string;

  const schoolId = randomUUID();
  const sub = `sa3-plan-${schoolId.slice(0, 8)}`;

  const server = () => app.getHttpServer();
  const cookiesOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[]) ?? [];
  const cookieHeader = (cs: string[]) => cs.map((c) => c.split(';')[0]).join('; ');
  const csrfOf = (cs: string[]) => (cs.find((c) => c.startsWith('platform_csrf=')) ?? '').split(';')[0].split('=')[1];
  const login = (email: string) =>
    request(server()).post('/api/v1/platform/auth/login').set('Host', HOST).send({ email, password });

  let superCookies: string[];
  let analystCookies: string[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    superId = (await platform.platformUser.create({ data: { email: superEmail, name: 'SA3 Super', role: 'SUPER_ADMIN', status: 'ACTIVE', passwordHash } })).id;
    analystId = (await platform.platformUser.create({ data: { email: analystEmail, name: 'SA3 Analyst', role: 'ANALYST', status: 'ACTIVE', passwordHash } })).id;

    await platform.school.create({ data: { id: schoolId, name: 'SA3 Plan School', subdomain: sub, planTier: 'BASIC' } });
    await platform.campus.create({ data: { schoolId, name: 'Main' } });

    superCookies = cookiesOf(await login(superEmail));
    analystCookies = cookiesOf(await login(analystEmail));
  });

  afterAll(async () => {
    for (const uid of [superId, analystId].filter(Boolean) as string[]) {
      await platform.platformAuditLog.deleteMany({ where: { platformUserId: uid } });
      await platform.platformRefreshToken.deleteMany({ where: { platformUserId: uid } });
    }
    await destroyTenant(platform, schoolId);
    await platform.platformUser.deleteMany({ where: { id: { in: [superId, analystId].filter(Boolean) as string[] } } });
    await app.close();
  });

  it('exposes the plan catalog as an open read (200) with defined limits', async () => {
    const res = await request(server())
      .get('/api/v1/platform/plans')
      .set('Host', HOST)
      .set('Cookie', cookieHeader(analystCookies)); // a read-only operator may read it
    expect(res.status).toBe(200);
    for (const tier of ['BASIC', 'PLUS', 'PRO']) {
      expect(res.body[tier]).toMatchObject({
        maxStudents: expect.any(Number),
        maxStaff: expect.any(Number),
        maxCampuses: expect.any(Number),
        storageMb: expect.any(Number),
        monthlySmsCredits: expect.any(Number),
      });
    }
    // A higher tier grants strictly more — the catalog is ordered, not arbitrary.
    expect(res.body.PRO.maxStudents).toBeGreaterThan(res.body.BASIC.maxStudents);
  });

  it('lets a SUPER_ADMIN change a tenant plan (200) and audits from→to', async () => {
    const res = await request(server())
      .patch(`/api/v1/platform/tenants/${schoolId}/plan`)
      .set('Host', HOST).set('Cookie', cookieHeader(superCookies)).set('X-CSRF-Token', csrfOf(superCookies))
      .send({ planTier: 'PRO' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: schoolId, planTier: 'PRO' });

    const school = await platform.school.findUnique({ where: { id: schoolId }, select: { planTier: true } });
    expect(school?.planTier).toBe('PRO');

    const rows = await platform.platformAuditLog.findMany({ where: { action: 'TENANT_PLAN_CHANGE', targetTenantId: schoolId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].platformUserId).toBe(superId);
    // The change is recorded as a diff (BASIC → PRO), not just a blob.
    expect(rows[0].metadata).toMatchObject({ from: 'BASIC', to: 'PRO' });
  });

  it('forbids an ANALYST from changing a plan (403) and records nothing', async () => {
    const res = await request(server())
      .patch(`/api/v1/platform/tenants/${schoolId}/plan`)
      .set('Host', HOST).set('Cookie', cookieHeader(analystCookies)).set('X-CSRF-Token', csrfOf(analystCookies))
      .send({ planTier: 'PLUS' });
    expect(res.status).toBe(403);
    // Still PRO from the previous test; the refused write never ran.
    const school = await platform.school.findUnique({ where: { id: schoolId }, select: { planTier: true } });
    expect(school?.planTier).toBe('PRO');
  });

  it('rejects an unknown plan tier (400)', async () => {
    const res = await request(server())
      .patch(`/api/v1/platform/tenants/${schoolId}/plan`)
      .set('Host', HOST).set('Cookie', cookieHeader(superCookies)).set('X-CSRF-Token', csrfOf(superCookies))
      .send({ planTier: 'ENTERPRISE' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a plan change without the CSRF header (403)', async () => {
    const res = await request(server())
      .patch(`/api/v1/platform/tenants/${schoolId}/plan`)
      .set('Host', HOST).set('Cookie', cookieHeader(superCookies))
      .send({ planTier: 'PLUS' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });
});
