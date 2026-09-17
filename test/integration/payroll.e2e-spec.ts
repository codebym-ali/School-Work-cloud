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
 * Payroll (GAP-05): salary, draft run, recompute, approve, pay — and who may see a salary at all.
 *
 * ⚠️ The first case is a leak found reading the code before building the screen: `GET
 * /staff/:id/salary-structures` had no role gate, and the service only narrowed by campus — so a teacher could
 * read every colleague's salary on their campus.
 */
describe('Payroll (e2e, GAP-05)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let campusId: string;
  let owner: string[];
  let teacherCookies: string[];
  const staffIds: Record<string, string> = {};

  const sub = `pay-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const ownerLogin = { email: 'owner@pay.pk', password: 'Owner!Secret12' };
  const teacherLogin = { email: 'teacher@pay.pk', password: 'Teach!Secret12' };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const send = (method: 'post' | 'patch' | 'delete', p: string, b: object, cookies: string[]) =>
    request(server())[method](p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send(b);
  const get = (p: string, cookies: string[]) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    platform = app.get(PlatformPrismaService);

    const prov = await app.get(ProvisioningService, { strict: false })
      .provisionSchool({ name: 'Payroll School', subdomain: sub, ownerEmail: ownerLogin.email, ownerPassword: ownerLogin.password });
    schoolId = prov.schoolId;
    campusId = prov.campusId;
    // Enrolled: approving payroll and marking a payslip paid are two-factor gated.
    owner = await enrolMfa(server(), host, (await loginRequest(server(), host, ownerLogin.email, ownerLogin.password)).headers['set-cookie'] as unknown as string[]);

    const mk = async (key: string, email: string, password?: string) => {
      const res = await send('post', '/api/v1/staff', {
        email, staffType: 'TEACHER', employeeCode: `E-${key}`, designation: 'Teacher', joinedAt: '2026-04-01', campusId,
        ...(password ? { password } : {}),
      }, owner);
      expect(res.status).toBe(201);
      staffIds[key] = res.body.staffId;
    };
    await mk('teacher', teacherLogin.email, teacherLogin.password);
    await mk('colleague', 'colleague@pay.pk');
    await mk('unpaid', 'nosalary@pay.pk'); // never given a salary structure

    await send('post', `/api/v1/staff/${staffIds.colleague}/salary-structures`, { basic: 60000, allowances: { House: 10000 }, effectiveFrom: '2026-04-01' }, owner);
    await send('post', `/api/v1/staff/${staffIds.teacher}/salary-structures`, { basic: 40000, effectiveFrom: '2026-04-01' }, owner);
    teacherCookies = (await loginRequest(server(), host, teacherLogin.email, teacherLogin.password)).headers['set-cookie'] as unknown as string[];
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it("does not let a teacher read a colleague's salary", async () => {
    const res = await get(`/api/v1/staff/${staffIds.colleague}/salary-structures`, teacherCookies);
    expect(res.status).toBe(403);
  });

  it('still lets the owner read it', async () => {
    const res = await get(`/api/v1/staff/${staffIds.colleague}/salary-structures`, owner);
    expect(res.status).toBe(200);
    expect(Number(res.body[0].basic)).toBe(60000);
  });
  describe('runs', () => {
    const MONTH = { month: 7, year: 2026 };
    let runId: string;

    it('drafts a run, and names the staff member it had to leave out', async () => {
      const res = await send('post', '/api/v1/payroll-runs', { campusId, ...MONTH }, owner);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ payslips: 2, excluded: 1 });
      runId = res.body.runId;

      const detail = await get(`/api/v1/payroll-runs/${runId}`, owner);
      // Skipped silently before: a teacher with no salary structure just was not paid, and no reviewer saw it.
      expect(detail.body.excluded).toEqual([expect.objectContaining({ staffId: staffIds.unpaid, reason: 'No salary structure for this month' })]);
      const colleague = detail.body.payslips.find((p: { staffId: string }) => p.staffId === staffIds.colleague);
      expect(Number(colleague.gross)).toBe(70000);
    });

    it('lists runs with their totals (there was no list at all)', async () => {
      const res = await get('/api/v1/payroll-runs', owner);
      expect(res.status).toBe(200);
      expect(res.body[0]).toMatchObject({ id: runId, status: 'DRAFT', payslips: 2, paid: 0, totalNet: 110000 });
    });

    it('discards a draft so a correction reaches the month (B10)', async () => {
      // Give the left-out teacher a salary AFTER drafting — previously this could never reach July's pay.
      await send('post', `/api/v1/staff/${staffIds.unpaid}/salary-structures`, { basic: 30000, effectiveFrom: '2026-04-01' }, owner);
      expect((await send('delete', `/api/v1/payroll-runs/${runId}`, {}, owner)).status).toBe(204);

      const again = await send('post', '/api/v1/payroll-runs', { campusId, ...MONTH }, owner);
      expect(again.body).toMatchObject({ payslips: 3, excluded: 0 });
      runId = again.body.runId;
    });

    it('refuses to discard an approved run, and records a payment only once', async () => {
      expect((await send('post', `/api/v1/payroll-runs/${runId}/approve`, {}, owner)).status).toBe(201);
      expect((await send('delete', `/api/v1/payroll-runs/${runId}`, {}, owner)).status).toBe(409);

      const payslipId = (await get(`/api/v1/payroll-runs/${runId}`, owner)).body.payslips[0].id;
      expect((await send('patch', `/api/v1/payslips/${payslipId}/mark-paid`, { method: 'BANK_TRANSFER', reference: 'TX-1' }, owner)).status).toBe(200);
      // A second click used to overwrite the date and method of a salary already paid.
      const twice = await send('patch', `/api/v1/payslips/${payslipId}/mark-paid`, { method: 'CASH' }, owner);
      expect(twice.status).toBe(409);
      expect((await platform.payslip.findUniqueOrThrow({ where: { id: payslipId } })).paymentMethod).toBe('BANK_TRANSFER');
    });

    it('answers two runs of the same month started at once without a 500', async () => {
      const AUG = { month: 8, year: 2026 };
      const results = await Promise.all([
        send('post', '/api/v1/payroll-runs', { campusId, ...AUG }, owner),
        send('post', '/api/v1/payroll-runs', { campusId, ...AUG }, owner),
      ]);
      for (const r of results) expect([201, 409]).toContain(r.status);
      expect(await platform.payrollRun.count({ where: { schoolId, month: 8, year: 2026 } })).toBe(1);
    });
  });
});
