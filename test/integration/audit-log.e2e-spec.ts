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
 * The activity log's paging (GAP-06, B8).
 *
 * ⚠️ These pin the property offset paging could not give: a reader walking the log page by page sees every
 * entry EXACTLY once, even when entries share a timestamp and new ones are written while they read.
 * Rows are inserted directly so ties and interleaving are deterministic rather than timing-dependent.
 */
describe('Activity log paging (e2e, B8)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let ownerId: string;
  let cookies: string[];

  const sub = `aud-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@aud.pk', password: 'Owner!Secret12' };
  const MARK = 'TEST_PAGING';

  const page = (cursor?: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/audit-logs?action=${MARK}&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      .set('Host', host).set('Cookie', cookies);

  const insert = (n: number, at: Date) =>
    platform.auditLog.createMany({
      data: Array.from({ length: n }, () => ({
        schoolId, userId: ownerId, action: MARK, entityType: 'Test', entityId: randomUUID(), createdAt: at,
      })),
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    platform = app.get(PlatformPrismaService);

    const prov = await app.get(ProvisioningService, { strict: false })
      .provisionSchool({ name: 'Audit School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;
    ownerId = (await platform.user.findFirstOrThrow({ where: { schoolId, email: owner.email } })).id;
    cookies = (await loginRequest(app.getHttpServer(), host, owner.email, owner.password)).headers['set-cookie'] as unknown as string[];
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('walks every entry exactly once — through timestamp ties and entries written mid-browse', async () => {
    // Seven entries sharing ONE timestamp: ordering by createdAt alone would skip across page boundaries.
    const tied = new Date('2026-09-16T08:00:00.000Z');
    await insert(7, tied);
    const expected = (await platform.auditLog.findMany({ where: { schoolId, action: MARK }, select: { id: true } })).map((r) => r.id);

    const seen: string[] = [];
    let res = await page();
    expect(res.status).toBe(200);
    seen.push(...res.body.data.map((r: { id: string }) => r.id));

    // A NEWER entry lands while the reader is on page one. With OFFSET paging every later page shifts by
    // one and a row repeats. With a keyset it sits above the cursor and cannot disturb what follows.
    await insert(1, new Date('2026-09-16T09:00:00.000Z'));

    while (res.body.nextCursor) {
      res = await page(res.body.nextCursor);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.map((r: { id: string }) => r.id));
    }

    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    expect([...seen].sort()).toEqual([...expected].sort()); // no skips
  });

  it('names the actor instead of returning a bare user id', async () => {
    const res = await page();
    expect(res.body.data[0].actor).toBe(owner.email);
  });

  it('refuses a tampered cursor instead of silently restarting from the top', async () => {
    const res = await page('bm90LWEtY3Vyc29y');
    expect(res.status).toBe(400);
  });
});
