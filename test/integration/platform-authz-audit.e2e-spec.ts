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
 * Platform role split + audit trail (SA0, blueprint §24). The old console had ONE kind of operator
 * (PLATFORM_ADMIN) who could do everything; SA0 splits reads from writes — SUPPORT/BILLING/ANALYST
 * may look, only SUPER_ADMIN may act — and records every act. This exercises both halves against the
 * BYPASSRLS platform client: a read-only operator is refused at every mutation, and each successful
 * mutation leaves exactly one attributable `platform_audit_logs` row.
 */
describe('Platform role split + audit trail (e2e, §24 SA0)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;

  const HOST = 'admin.localhost';
  const password = 'Operator!Secret12';

  // Two operators on opposite sides of the read/full split.
  const superEmail = `super-${randomUUID().slice(0, 8)}@platform.pk`;
  const analystEmail = `analyst-${randomUUID().slice(0, 8)}@platform.pk`;
  let superId: string;
  let analystId: string;

  // A pre-seeded tenant the ANALYST tries (and fails) to act on, and against which a blank-reason
  // suspend is refused. It is only ever the target of 4xx attempts, so it stays ACTIVE throughout.
  const seededSchoolId = randomUUID();
  const seededSub = `sa0-seed-${seededSchoolId.slice(0, 8)}`;

  // A tenant provisioned through the console so the provision/suspend/reactivate audit rows can be
  // read straight off the table.
  const provSub = `sa0-prov-${randomUUID().slice(0, 8)}`;
  const provOwnerEmail = `owner-${provSub}@example.com`;
  let provSchoolId: string;

  const server = () => app.getHttpServer();
  const cookiesOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[]) ?? [];
  const cookieHeader = (cs: string[]) => cs.map((c) => c.split(';')[0]).join('; ');
  const csrfOf = (cs: string[]) => (cs.find((c) => c.startsWith('platform_csrf=')) ?? '').split(';')[0].split('=')[1];

  const platformLogin = (loginEmail: string) =>
    request(server()).post('/api/v1/platform/auth/login').set('Host', HOST).send({ email: loginEmail, password });

  // The three write actions — a role refusal must leave none of them in the log.
  const WRITE_ACTIONS = ['TENANT_PROVISION', 'TENANT_SUSPEND', 'TENANT_REACTIVATE'];

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

    superId = (
      await platform.platformUser.create({
        data: { email: superEmail, name: 'SA0 Super Admin', role: 'SUPER_ADMIN', status: 'ACTIVE', passwordHash },
      })
    ).id;
    analystId = (
      await platform.platformUser.create({
        data: { email: analystEmail, name: 'SA0 Analyst', role: 'ANALYST', status: 'ACTIVE', passwordHash },
      })
    ).id;

    // A plain seeded tenant (no console provisioning) — enough of a school to be a valid suspend
    // target for the refusal cases.
    await platform.school.create({ data: { id: seededSchoolId, name: 'SA0 Seed', subdomain: seededSub } });
    await platform.campus.create({ data: { schoolId: seededSchoolId, name: 'Main' } });

    superCookies = cookiesOf(await platformLogin(superEmail));
    analystCookies = cookiesOf(await platformLogin(analystEmail));
  });

  afterAll(async () => {
    for (const sid of [seededSchoolId, provSchoolId].filter(Boolean) as string[]) await destroyTenant(platform, sid);
    for (const uid of [superId, analystId].filter(Boolean) as string[]) {
      await platform.platformAuditLog.deleteMany({ where: { platformUserId: uid } });
      await platform.platformRefreshToken.deleteMany({ where: { platformUserId: uid } });
    }
    await platform.platformUser.deleteMany({ where: { id: { in: [superId, analystId].filter(Boolean) as string[] } } });
    await app.close();
  });

  describe('role enforcement — a read-only operator may look but not act', () => {
    it('lets an ANALYST read the tenant list (200)', async () => {
      const res = await request(server())
        .get('/api/v1/platform/tenants')
        .set('Host', HOST)
        .set('Cookie', cookieHeader(analystCookies));
      expect(res.status).toBe(200);
    });

    it('forbids an ANALYST from provisioning a tenant (403)', async () => {
      const res = await request(server())
        .post('/api/v1/platform/tenants')
        .set('Host', HOST)
        .set('Cookie', cookieHeader(analystCookies))
        .set('X-CSRF-Token', csrfOf(analystCookies))
        .send({
          name: 'Analyst Should Not',
          subdomain: `sa0-analyst-${randomUUID().slice(0, 8)}`,
          ownerEmail: 'x@example.com',
        });
      expect(res.status).toBe(403);
    });

    it('forbids an ANALYST from suspending a tenant (403)', async () => {
      const res = await request(server())
        .post(`/api/v1/platform/tenants/${seededSchoolId}/suspend`)
        .set('Host', HOST)
        .set('Cookie', cookieHeader(analystCookies))
        .set('X-CSRF-Token', csrfOf(analystCookies))
        .send({ reason: 'should never apply' });
      expect(res.status).toBe(403);
    });

    it('forbids an ANALYST from reactivating a tenant (403)', async () => {
      const res = await request(server())
        .post(`/api/v1/platform/tenants/${seededSchoolId}/reactivate`)
        .set('Host', HOST)
        .set('Cookie', cookieHeader(analystCookies))
        .set('X-CSRF-Token', csrfOf(analystCookies));
      expect(res.status).toBe(403);
    });

    it('a role-refused write reaches the log as nothing — the action never ran', async () => {
      // The point of the split is that a denied operator does not merely fail to persist a tenant
      // change; the change never executes, so there is nothing to audit against them.
      const rows = await platform.platformAuditLog.count({
        where: { platformUserId: analystId, action: { in: WRITE_ACTIONS } },
      });
      expect(rows).toBe(0);
    });
  });

  describe('audit trail — every write is attributed to its operator', () => {
    it('provisioning writes a single TENANT_PROVISION row for the acting super-admin', async () => {
      const res = await request(server())
        .post('/api/v1/platform/tenants')
        .set('Host', HOST)
        .set('Cookie', cookieHeader(superCookies))
        .set('X-CSRF-Token', csrfOf(superCookies))
        .send({ name: 'SA0 Provisioned', subdomain: provSub, ownerEmail: provOwnerEmail });
      expect(res.status).toBe(201);
      provSchoolId = res.body.id;

      const rows = await platform.platformAuditLog.findMany({
        where: { action: 'TENANT_PROVISION', targetTenantId: provSchoolId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].platformUserId).toBe(superId);
    });

    it('suspending writes a TENANT_SUSPEND row that carries the reason', async () => {
      const reason = 'Non-payment — 60 days overdue';
      const res = await request(server())
        .post(`/api/v1/platform/tenants/${provSchoolId}/suspend`)
        .set('Host', HOST)
        .set('Cookie', cookieHeader(superCookies))
        .set('X-CSRF-Token', csrfOf(superCookies))
        .send({ reason });
      expect(res.status).toBe(200);

      const rows = await platform.platformAuditLog.findMany({
        where: { action: 'TENANT_SUSPEND', targetTenantId: provSchoolId },
      });
      expect(rows).toHaveLength(1);
      // The reason is the whole justification for the suspension — it must survive to the log, not
      // just gate the request.
      expect(rows[0]).toMatchObject({ platformUserId: superId, reason });
    });

    it('reactivating writes a TENANT_REACTIVATE row for the operator', async () => {
      const res = await request(server())
        .post(`/api/v1/platform/tenants/${provSchoolId}/reactivate`)
        .set('Host', HOST)
        .set('Cookie', cookieHeader(superCookies))
        .set('X-CSRF-Token', csrfOf(superCookies));
      expect(res.status).toBe(200);

      const rows = await platform.platformAuditLog.findMany({
        where: { action: 'TENANT_REACTIVATE', targetTenantId: provSchoolId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].platformUserId).toBe(superId);
    });
  });

  describe('suspend requires a reason', () => {
    it('rejects a blank reason (400) and records no suspension', async () => {
      const before = await platform.platformAuditLog.count({
        where: { action: 'TENANT_SUSPEND', targetTenantId: seededSchoolId },
      });
      const res = await request(server())
        .post(`/api/v1/platform/tenants/${seededSchoolId}/suspend`)
        .set('Host', HOST)
        .set('Cookie', cookieHeader(superCookies))
        .set('X-CSRF-Token', csrfOf(superCookies))
        .send({ reason: '' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      // A refused suspend leaves the log untouched.
      expect(
        await platform.platformAuditLog.count({ where: { action: 'TENANT_SUSPEND', targetTenantId: seededSchoolId } }),
      ).toBe(before);
    });

    it('rejects a missing reason (400)', async () => {
      const res = await request(server())
        .post(`/api/v1/platform/tenants/${seededSchoolId}/suspend`)
        .set('Host', HOST)
        .set('Cookie', cookieHeader(superCookies))
        .set('X-CSRF-Token', csrfOf(superCookies))
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });
});
