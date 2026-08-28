import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../apps/api/src/app.module';
import { PlatformPrismaService } from '@database';

/**
 * Leads / demo requests — SA8. The public marketing site captures a demo request through an
 * UNAUTHENTICATED endpoint (no session, no CSRF), and the console works the pipeline — confined to
 * SUPER_ADMIN + SUPPORT. A honeypot drops obvious bots; every operator update is audited.
 */
describe('Platform leads / demo requests (e2e, §24 SA8)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;

  const HOST = 'admin.localhost';
  const password = 'Operator!Secret12';
  const tag = randomUUID().slice(0, 8);
  const opEmail = (r: string) => `leads-${r}-${tag}@platform.pk`;
  const leadEmail = (p: string) => `${p}-${tag}@example.com`;
  const ids: Record<string, string> = {};

  const server = () => app.getHttpServer();
  const cookiesOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[]) ?? [];
  const cookieHeader = (cs: string[]) => cs.map((c) => c.split(';')[0]).join('; ');
  const csrfOf = (cs: string[]) => (cs.find((c) => c.startsWith('platform_csrf=')) ?? '').split(';')[0].split('=')[1];
  const login = (email: string) => request(server()).post('/api/v1/platform/auth/login').set('Host', HOST).send({ email, password });
  const get = (cs: string[], path: string) => request(server()).get(`/api/v1/platform/${path}`).set('Host', HOST).set('Cookie', cookieHeader(cs));
  const patch = (cs: string[], path: string, body: unknown) =>
    request(server()).patch(`/api/v1/platform/${path}`).set('Host', HOST).set('Cookie', cookieHeader(cs)).set('X-CSRF-Token', csrfOf(cs)).send(body);
  const publicPost = (body: unknown) => request(server()).post('/api/v1/platform/public/demo-request').set('Host', HOST).send(body);

  let superC: string[], supportC: string[], billingC: string[], analystC: string[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    for (const role of ['SUPER_ADMIN', 'SUPPORT', 'BILLING', 'ANALYST'] as const) {
      ids[role] = (await platform.platformUser.create({ data: { email: opEmail(role.toLowerCase()), name: role, role, status: 'ACTIVE', passwordHash } })).id;
    }
    superC = cookiesOf(await login(opEmail('super_admin')));
    supportC = cookiesOf(await login(opEmail('support')));
    billingC = cookiesOf(await login(opEmail('billing')));
    analystC = cookiesOf(await login(opEmail('analyst')));
  });

  afterAll(async () => {
    await platform.platformLead.deleteMany({ where: { email: { contains: tag } } });
    const uids = Object.values(ids);
    await platform.platformAuditLog.deleteMany({ where: { platformUserId: { in: uids } } });
    await platform.platformRefreshToken.deleteMany({ where: { platformUserId: { in: uids } } });
    await platform.platformUser.deleteMany({ where: { id: { in: uids } } });
    await app.close();
  });

  it('captures a demo request from the public — unauthenticated, no CSRF (201)', async () => {
    const res = await publicPost({ name: 'Ayesha Khan', email: leadEmail('ayesha'), schoolName: 'Iqra Model School', phone: '0300-1234567', studentCount: 420, message: 'Interested in fees + SMS' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true });
    const lead = await platform.platformLead.findFirst({ where: { email: leadEmail('ayesha') } });
    expect(lead).toMatchObject({ name: 'Ayesha Khan', schoolName: 'Iqra Model School', studentCount: 420, status: 'NEW', source: 'marketing-site' });
  });

  it('drops a honeypot submission silently (201, nothing saved)', async () => {
    const res = await publicPost({ name: 'Spam Bot', email: leadEmail('bot'), website: 'http://spam.example' });
    expect(res.status).toBe(201);
    expect(await platform.platformLead.count({ where: { email: leadEmail('bot') } })).toBe(0);
  });

  it('rejects an invalid public submission (400)', async () => {
    expect((await publicPost({ name: '', email: 'not-an-email' })).status).toBe(400);
  });

  it('lists leads for SUPER_ADMIN and SUPPORT; forbids BILLING and ANALYST (403)', async () => {
    expect((await get(superC, 'leads')).status).toBe(200);
    expect((await get(supportC, 'leads')).status).toBe(200);
    expect((await get(billingC, 'leads')).status).toBe(403);
    expect((await get(analystC, 'leads')).status).toBe(403);
  });

  it('advances a lead through the pipeline (SUPPORT) — stamps the handler and audits it', async () => {
    const lead = await platform.platformLead.findFirstOrThrow({ where: { email: leadEmail('ayesha') } });
    const res = await patch(supportC, `leads/${lead.id}`, { status: 'CONTACTED', note: 'Called — demo booked Tue' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'CONTACTED', note: 'Called — demo booked Tue' });
    const db = await platform.platformLead.findUnique({ where: { id: lead.id }, select: { status: true, handledById: true, handledAt: true } });
    expect(db).toMatchObject({ status: 'CONTACTED', handledById: ids.SUPPORT });
    expect(db!.handledAt).toBeTruthy();
    expect(await platform.platformAuditLog.count({ where: { action: 'LEAD_UPDATE', platformUserId: ids.SUPPORT } })).toBeGreaterThanOrEqual(1);
  });

  it('forbids BILLING and ANALYST from updating a lead (403)', async () => {
    const lead = await platform.platformLead.findFirstOrThrow({ where: { email: leadEmail('ayesha') } });
    expect((await patch(billingC, `leads/${lead.id}`, { status: 'CLOSED' })).status).toBe(403);
    expect((await patch(analystC, `leads/${lead.id}`, { status: 'CLOSED' })).status).toBe(403);
  });
});
