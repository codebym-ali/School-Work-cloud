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

const NIL = '00000000-0000-0000-0000-000000000000';

/**
 * MFA money-out gates (QA plan C6). `mfa-enforcement.e2e` proves the ENROLMENT gate mechanism on one
 * representative route; this pins that EVERY money-out / high-authority action stays behind it — a regression
 * that drops `@RequiresMfa` from just one (say `waive` while `reverse` keeps it) would silently disarm a
 * financial control. The MfaEnrolledGuard runs before the service, so a nil id is enough to reach the gate:
 * an un-enrolled owner gets 403 MFA_ENROLMENT_REQUIRED; once enrolled, the same route no longer answers with
 * that code (it 404s on the nil id instead — proving the gate, not the action, was what stood in the way).
 */
describe('MFA money-out gates — every sensitive action stays enrolment-gated (e2e, C6)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let unenrolled: string[];
  let enrolled: string[];
  const host = `mfam-${randomUUID().slice(0, 6)}.localhost`;
  const email = 'owner@mfam.pk';
  const password = 'Owner!Secret12';

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const call = (method: 'post' | 'patch', p: string, body: object, cookies: string[]) =>
    request(server())[method](p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).set('Idempotency-Key', randomUUID()).send(body);

  const routes: Array<{ label: string; method: 'post' | 'patch'; path: string; body: object }> = [
    { label: 'waive a fine', method: 'post', path: `/api/v1/fees/invoices/${NIL}/waive`, body: { reason: 'x' } },
    { label: 'reverse a payment', method: 'post', path: `/api/v1/fees/payments/${NIL}/reversals`, body: { reason: 'x' } },
    { label: 'approve payroll', method: 'post', path: `/api/v1/payroll-runs/${NIL}/approve`, body: {} },
    { label: 'mark a payslip paid', method: 'patch', path: `/api/v1/payslips/${NIL}/mark-paid`, body: {} },
    { label: 'reset a user password', method: 'post', path: `/api/v1/users/${NIL}/reset-password`, body: { password: 'Reset!Secret12Aa' } },
  ];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    platform = app.get(PlatformPrismaService);

    const prov = await app.get(ProvisioningService, { strict: false }).provisionSchool({ name: 'MFA Money School', subdomain: host.split('.')[0], ownerEmail: email, ownerPassword: password });
    schoolId = prov.schoolId;
    unenrolled = (await loginRequest(server(), host, email, password)).headers['set-cookie'] as unknown as string[];
    // A second, MFA-enrolled owner session (separate login) for the positive half.
    enrolled = await enrolMfa(server(), host, (await loginRequest(server(), host, email, password)).headers['set-cookie'] as unknown as string[]);
  });

  afterAll(async () => {
    if (schoolId) await destroyTenant(platform, schoolId);
    await app.close();
  });

  for (const r of routes) {
    it(`${r.label}: un-enrolled owner → 403 MFA_ENROLMENT_REQUIRED`, async () => {
      const res = await call(r.method, r.path, r.body, unenrolled);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('MFA_ENROLMENT_REQUIRED');
    });

    it(`${r.label}: enrolled owner is no longer MFA-blocked`, async () => {
      const res = await call(r.method, r.path, r.body, enrolled);
      expect(res.body?.error?.code).not.toBe('MFA_ENROLMENT_REQUIRED');
    });
  }
});
