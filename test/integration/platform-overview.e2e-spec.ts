import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../apps/api/src/app.module';
import { PlatformPrismaService } from '@database';

/**
 * Fleet Overview (SA1, blueprint §24). The dashboard reads the most recent nightly `platform_stats`
 * snapshot via GET /platform/overview — a READ, so open to every operator role (not just SUPER_ADMIN).
 * This proves the endpoint returns the latest snapshot's defined totals (SA-P7), is reachable by a
 * read-only operator, and is closed to an unauthenticated caller.
 *
 * `no-worker.js` guards this file too (it shares the BullMQ queue guard via globalSetup); it does not
 * touch SMS, but the guard is fleet-wide.
 */
describe('Platform fleet overview (e2e, §24 SA1)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;

  const HOST = 'admin.localhost';
  const password = 'Operator!Secret12';
  const analystEmail = `overview-analyst-${randomUUID().slice(0, 8)}@platform.pk`;
  let analystId: string;

  // A sentinel snapshot with capturedAt in the FUTURE and distinctive values, so it is
  // unambiguously the latest row `getOverview` returns regardless of any real snapshot the nightly
  // job may have left in the shared dev DB. Removed in teardown.
  let snapshotId: string;
  const capturedAt = new Date(Date.now() + 60 * 60 * 1000);
  const SENTINEL = {
    schoolsTotal: 4242,
    schoolsActive: 4000,
    schoolsSuspended: 242,
    studentsActive: 987654,
    staffEmployed: 54321,
    newSchools30d: 17,
  };

  const server = () => app.getHttpServer();
  const cookiesOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[]) ?? [];
  const cookieHeader = (cs: string[]) => cs.map((c) => c.split(';')[0]).join('; ');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    analystId = (
      await platform.platformUser.create({
        data: { email: analystEmail, name: 'SA1 Analyst', role: 'ANALYST', status: 'ACTIVE', passwordHash },
      })
    ).id;

    snapshotId = (await platform.platformStatsSnapshot.create({ data: { capturedAt, ...SENTINEL } })).id;
  });

  afterAll(async () => {
    if (snapshotId) await platform.platformStatsSnapshot.delete({ where: { id: snapshotId } }).catch(() => {});
    if (analystId) {
      await platform.platformRefreshToken.deleteMany({ where: { platformUserId: analystId } });
      await platform.platformUser.delete({ where: { id: analystId } }).catch(() => {});
    }
    await app.close();
  });

  it('returns the latest snapshot totals to a read-only operator (200)', async () => {
    // An ANALYST is read-only (403 on every write) — that it can read the overview proves the
    // endpoint carries no @PlatformRoles and is open to every operator role, like the tenant list.
    const login = await request(server())
      .post('/api/v1/platform/auth/login')
      .set('Host', HOST)
      .send({ email: analystEmail, password });
    const cookies = cookiesOf(login);

    const res = await request(server())
      .get('/api/v1/platform/overview')
      .set('Host', HOST)
      .set('Cookie', cookieHeader(cookies));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(SENTINEL);
    // capturedAt round-trips as an ISO string of the same instant (TIMESTAMP(3), ms precision).
    expect(new Date(res.body.capturedAt).getTime()).toBe(capturedAt.getTime());
  });

  it('is closed to an unauthenticated caller (401)', async () => {
    const res = await request(server()).get('/api/v1/platform/overview').set('Host', HOST);
    expect(res.status).toBe(401);
  });
});
