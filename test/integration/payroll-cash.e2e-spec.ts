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
import { enrolMfa } from './support/mfa';

/**
 * Cash payroll (Cash Payroll Plan, WS4.1).
 *
 * The agreed model: each campus's accountant drafts the month and hands over cash, the owner approves, and staff
 * see a payslip only once it is approved. Each case here failed against the owner-only payroll it replaces —
 * most importantly the campus cases, because opening the routes to a campus-bound accountant without them would
 * have let campus A pay campus B.
 */
describe('Cash payroll (e2e)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let campusA: string;
  let campusB: string;
  let owner: string[];
  let acctA: string[];
  let acctB: string[];
  let teacher: string[];
  const staff: Record<string, string> = {};

  const sub = `cash-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const pw = 'Cash!Secret1234';
  const MONTH = { month: 7, year: 2026 };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const send = (method: 'post' | 'patch' | 'delete', p: string, b: object, cookies: string[]) =>
    request(server())[method](p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send(b);
  const get = (p: string, cookies: string[]) => request(server()).get(p).set('Host', host).set('Cookie', cookies);
  const login = async (email: string) => (await loginRequest(server(), host, email, pw)).headers['set-cookie'] as unknown as string[];

  async function hire(key: string, campusId: string, staffType: string, roles: string[], salary: number) {
    const res = await send('post', '/api/v1/staff', {
      email: `${key}@cash.pk`, staffType, employeeCode: `E-${key}`, fullName: `Person ${key}`, designation: staffType,
      joinedAt: '2026-01-01', campusId, password: pw, roles,
    }, owner);
    expect(res.status).toBe(201);
    staff[key] = res.body.staffId;
    expect((await send('post', `/api/v1/staff/${staff[key]}/salary-structures`, { basic: salary, effectiveFrom: '2026-01-01' }, owner)).status).toBe(201);
  }

  const payslipOf = async (runId: string, key: string) =>
    ((await get(`/api/v1/payroll-runs/${runId}`, owner)).body.payslips as Array<{ id: string; staffId: string }>).find((p) => p.staffId === staff[key])!;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    platform = app.get(PlatformPrismaService);

    const prov = await app.get(ProvisioningService, { strict: false })
      .provisionSchool({ name: 'Cash School', subdomain: sub, ownerEmail: 'owner@cash.pk', ownerPassword: pw });
    schoolId = prov.schoolId;
    campusA = prov.campusId;
    owner = await enrolMfa(server(), host, await login('owner@cash.pk'));
    campusB = (await send('post', '/api/v1/campuses', { name: 'Campus B' }, owner)).body.id;

    await hire('acct-a', campusA, 'ACCOUNTANT', ['ACCOUNTANT'], 30000);
    await hire('acct-b', campusB, 'ACCOUNTANT', ['ACCOUNTANT'], 30000);
    await hire('teach-a', campusA, 'TEACHER', ['TEACHER'], 40000);
    await hire('teach-b', campusB, 'TEACHER', ['TEACHER'], 40000);

    // Marking paid is two-factor gated for accountants, as for the owner.
    acctA = await enrolMfa(server(), host, await login('acct-a@cash.pk'));
    acctB = await enrolMfa(server(), host, await login('acct-b@cash.pk'));
    teacher = await login('teach-a@cash.pk');
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  let runA: string;

  it('lets the campus accountant draft their own campus', async () => {
    const res = await send('post', '/api/v1/payroll-runs', { campusId: campusA, ...MONTH }, acctA);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ payslips: 2 });
    runA = res.body.runId;
  });

  it("refuses an accountant another campus's payroll, for every step", async () => {
    expect((await send('post', '/api/v1/payroll-runs', { campusId: campusA, month: 8, year: 2026 }, acctB)).status).toBe(403);
    expect((await get(`/api/v1/payroll-runs/${runA}`, acctB)).status).toBe(403);
    expect((await send('delete', `/api/v1/payroll-runs/${runA}`, {}, acctB)).status).toBe(403);
    const list = await get('/api/v1/payroll-runs', acctB);
    expect(list.status).toBe(200);
    expect(list.body.map((r: { id: string }) => r.id)).not.toContain(runA);
  });

  it('never shows staff a draft payslip, in the list or as a PDF', async () => {
    expect((await get('/api/v1/payslips/mine', teacher)).body).toEqual([]);
    const slip = await payslipOf(runA, 'teach-a');
    expect((await get(`/api/v1/payslips/${slip.id}/pdf`, teacher)).status).toBe(404);
  });

  it('does not let the accountant approve', async () => {
    expect((await send('post', `/api/v1/payroll-runs/${runA}/approve`, {}, acctA)).status).toBe(403);
  });

  it('shows the payslip to staff once the owner approves, with its month', async () => {
    expect((await send('post', `/api/v1/payroll-runs/${runA}/approve`, {}, owner)).status).toBe(201);
    const mine = await get('/api/v1/payslips/mine', teacher);
    expect(mine.body).toEqual([expect.objectContaining({ month: 7, year: 2026, state: 'APPROVED' })]);
  });

  it("reminds the accountant of approved salaries still to pay, not counting their own", async () => {
    const items = (await get('/api/v1/notifications', acctA)).body.items as Array<{ kind: string; text: string; href: string }>;
    // Campus A approved: teach-a and acct-a are unpaid, but acct-a cannot pay their own, so 1.
    expect(items.find((i) => i.kind === 'SALARIES_TO_PAY')).toMatchObject({ text: '1 approved salary not yet paid.', href: '/payroll' });
    // Campus B has nothing approved yet.
    expect((await get('/api/v1/notifications', acctB)).body.items.some((i: { kind: string }) => i.kind === 'SALARIES_TO_PAY')).toBe(false);
  });

  it('records cash by default and who handed it over; once only', async () => {
    const slip = await payslipOf(runA, 'teach-a');
    const res = await send('patch', `/api/v1/payslips/${slip.id}/mark-paid`, {}, acctA);
    expect(res.status).toBe(200);
    const row = await platform.payslip.findUniqueOrThrow({ where: { id: slip.id } });
    const acctUser = await platform.user.findFirstOrThrow({ where: { schoolId, email: 'acct-a@cash.pk' } });
    expect(row).toMatchObject({ paymentMethod: 'CASH', paidById: acctUser.id });
    expect((await send('patch', `/api/v1/payslips/${slip.id}/mark-paid`, {}, acctA)).status).toBe(409);

    const detail = (await get(`/api/v1/payroll-runs/${runA}`, acctA)).body;
    expect(detail.payslips.find((p: { id: string }) => p.id === slip.id)).toMatchObject({ paidBy: 'acct-a@cash.pk', staffName: 'Person teach-a' });
    expect((await get('/api/v1/payslips/mine', teacher)).body[0].state).toBe('PAID');
  });

  it('does not let an accountant record their own salary as paid; the owner can', async () => {
    const own = await payslipOf(runA, 'acct-a');
    expect((await send('patch', `/api/v1/payslips/${own.id}/mark-paid`, {}, acctA)).status).toBe(403);
    expect((await send('patch', `/api/v1/payslips/${own.id}/mark-paid`, { method: 'CASH' }, owner)).status).toBe(200);
  });

  it("refuses an accountant marking another campus's payslip paid", async () => {
    const res = await send('post', '/api/v1/payroll-runs', { campusId: campusB, ...MONTH }, owner);
    await send('post', `/api/v1/payroll-runs/${res.body.runId}/approve`, {}, owner);
    const slipB = await payslipOf(res.body.runId, 'teach-b');
    expect((await send('patch', `/api/v1/payslips/${slipB.id}/mark-paid`, {}, acctA)).status).toBe(403);
  });

  it('keeps salary history away from the accountant', async () => {
    expect((await get(`/api/v1/staff/${staff['teach-a']}/salary-structures`, acctA)).status).toBe(403);
  });
});
