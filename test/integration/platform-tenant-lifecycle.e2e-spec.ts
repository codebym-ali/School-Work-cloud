import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../apps/api/src/app.module';
import { PlatformPrismaService } from '@database';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { destroyTenant } from './support/tenant';

/**
 * Tenant offboarding — SA7 (blueprint §24, SA-P5). Schedule a REVERSIBLE termination (retention
 * window), export the data, then the IRREVERSIBLE hard-delete only after the window + a subdomain
 * confirmation. The integrity gate: a purge removes EXACTLY one tenant, leaving zero orphans in any
 * school_id table, with every other tenant intact — the property whose absence once left 251 dead
 * schools behind.
 */
describe('Platform tenant offboarding (e2e, §24 SA7)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;

  const HOST = 'admin.localhost';
  const password = 'Operator!Secret12';
  const superEmail = `off-super-${randomUUID().slice(0, 8)}@platform.pk`;
  const analystEmail = `off-analyst-${randomUUID().slice(0, 8)}@platform.pk`;
  let superId: string;
  let analystId: string;

  // A is the purge target; B is the tenant that must remain untouched.
  let schoolA: string;
  let schoolB: string;
  const subA = `off-a-${randomUUID().slice(0, 8)}`;
  const subB = `off-b-${randomUUID().slice(0, 8)}`;

  const server = () => app.getHttpServer();
  const cookiesOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[]) ?? [];
  const cookieHeader = (cs: string[]) => cs.map((c) => c.split(';')[0]).join('; ');
  const csrfOf = (cs: string[]) => (cs.find((c) => c.startsWith('platform_csrf=')) ?? '').split(';')[0].split('=')[1];
  const login = (email: string) => request(server()).post('/api/v1/platform/auth/login').set('Host', HOST).send({ email, password });

  let superCookies: string[];
  let analystCookies: string[];

  const post = (cookies: string[], path: string, body?: unknown) =>
    request(server()).post(`/api/v1/platform/${path}`).set('Host', HOST).set('Cookie', cookieHeader(cookies)).set('X-CSRF-Token', csrfOf(cookies)).send(body ?? {});

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const provisioning = app.get(ProvisioningService, { strict: false });
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    superId = (await platform.platformUser.create({ data: { email: superEmail, name: 'Off Super', role: 'SUPER_ADMIN', status: 'ACTIVE', passwordHash } })).id;
    analystId = (await platform.platformUser.create({ data: { email: analystEmail, name: 'Off Analyst', role: 'ANALYST', status: 'ACTIVE', passwordHash } })).id;

    // Real tenants with data across several tables (school, campus, user, sms_templates, sms credit).
    schoolA = (await provisioning.provisionSchool({ name: 'Offboard A', subdomain: subA, ownerEmail: `owner-${subA}@example.com`, ownerPassword: 'OwnerA!Secret12' })).schoolId;
    schoolB = (await provisioning.provisionSchool({ name: 'Offboard B', subdomain: subB, ownerEmail: `owner-${subB}@example.com`, ownerPassword: 'OwnerB!Secret12' })).schoolId;

    superCookies = cookiesOf(await login(superEmail));
    analystCookies = cookiesOf(await login(analystEmail));
  });

  afterAll(async () => {
    const ids = [superId, analystId].filter(Boolean) as string[];
    for (const uid of ids) {
      await platform.platformAuditLog.deleteMany({ where: { platformUserId: uid } });
      await platform.platformRefreshToken.deleteMany({ where: { platformUserId: uid } });
    }
    for (const sid of [schoolA, schoolB]) await destroyTenant(platform, sid); // A already purged → no-op
    await platform.platformUser.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  it('schedules a reversible termination on B (suspends + retention window) and audits it', async () => {
    const res = await post(superCookies, `tenants/${schoolB}/terminate`, { reason: 'Non-renewal — closing 2026' });
    expect(res.status).toBe(200);
    expect(typeof res.body.purgeAfter).toBe('string');
    const db = await platform.school.findUnique({ where: { id: schoolB }, select: { isActive: true, purgeAfter: true, terminationReason: true } });
    expect(db?.isActive).toBe(false);
    expect(db?.purgeAfter).toBeTruthy();
    expect(db?.terminationReason).toBe('Non-renewal — closing 2026');
    const rows = await platform.platformAuditLog.findMany({ where: { action: 'TENANT_TERMINATE_SCHEDULE', targetTenantId: schoolB } });
    expect(rows).toHaveLength(1);
  });

  it('cancels the termination on B → reactivated', async () => {
    const res = await post(superCookies, `tenants/${schoolB}/cancel-termination`);
    expect(res.status).toBe(200);
    const db = await platform.school.findUnique({ where: { id: schoolB }, select: { isActive: true, purgeAfter: true } });
    expect(db).toMatchObject({ isActive: true, purgeAfter: null });
  });

  it('exports B (audited) with sensitive columns redacted', async () => {
    const res = await request(server()).get(`/api/v1/platform/tenants/${schoolB}/export`).set('Host', HOST).set('Cookie', cookieHeader(superCookies));
    expect(res.status).toBe(200);
    expect(res.body.rowCounts.schools).toBe(1);
    expect(res.body.rowCounts.users).toBeGreaterThanOrEqual(1);
    // The owner's password hash must never leave in the handover.
    expect((res.body.tables.users as Array<{ password_hash: unknown }>).every((u) => u.password_hash === '[redacted]')).toBe(true);
    const rows = await platform.platformAuditLog.findMany({ where: { action: 'TENANT_EXPORT', targetTenantId: schoolB } });
    expect(rows).toHaveLength(1);
  });

  it('refuses to purge before the retention window has elapsed (422)', async () => {
    await post(superCookies, `tenants/${schoolB}/terminate`, { reason: 're-terminate for purge tests' });
    const res = await post(superCookies, `tenants/${schoolB}/purge`, { confirmSubdomain: subB });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses to purge with a wrong subdomain confirmation (422), even after the window', async () => {
    // Backdate the window so only the confirmation stands between the request and deletion.
    await platform.school.update({ where: { id: schoolB }, data: { purgeAfter: new Date(Date.now() - 1000) } });
    const res = await post(superCookies, `tenants/${schoolB}/purge`, { confirmSubdomain: 'wrong-subdomain' });
    expect(res.status).toBe(422);
    // B still exists.
    expect(await platform.school.count({ where: { id: schoolB } })).toBe(1);
  });

  it('forbids a non-SUPER_ADMIN from purging (403)', async () => {
    const res = await post(analystCookies, `tenants/${schoolB}/purge`, { confirmSubdomain: subB });
    expect(res.status).toBe(403);
  });

  it('INTEGRITY GATE: purges A after the window, leaving ZERO orphans, with B fully intact', async () => {
    await post(superCookies, `tenants/${schoolA}/terminate`, { reason: 'offboard A' });
    await platform.school.update({ where: { id: schoolA }, data: { purgeAfter: new Date(Date.now() - 1000) } });

    const res = await post(superCookies, `tenants/${schoolA}/purge`, { confirmSubdomain: subA });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBeTruthy(); // per-table deleted counts

    // A's school row is gone.
    expect(await platform.school.count({ where: { id: schoolA } })).toBe(0);

    // ZERO orphans: no row in ANY school_id table still references A.
    const tables = await platform.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='school_id' AND table_name <> 'schools'`,
    );
    let orphans = 0;
    for (const { table_name } of tables) {
      const [{ n }] = await platform.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table_name}" WHERE school_id = $1::uuid`, schoolA);
      orphans += n;
    }
    expect(orphans).toBe(0);

    // B is completely untouched by A's purge.
    expect(await platform.school.count({ where: { id: schoolB } })).toBe(1);
    expect(await platform.user.count({ where: { schoolId: schoolB } })).toBeGreaterThanOrEqual(1);

    const audit = await platform.platformAuditLog.findMany({ where: { action: 'TENANT_PURGE', targetTenantId: schoolA } });
    expect(audit).toHaveLength(1); // the permanent record survives the deletion (no school_id)
  });
});
