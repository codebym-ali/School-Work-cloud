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

const NIL = '00000000-0000-0000-0000-000000000000';

/**
 * Error-envelope conformance (QA plan C7, blueprint §25.1). Every failure — whatever the status — must come
 * back as `{ error: { code, message, requestId? } }` with a STABLE machine `code` (the frontend switches on
 * `code`, never message text) and nothing leaked (no `stack`, no extra top-level keys). This samples one
 * error from each status class and pins the shape + code, so a handler that answers with a bare string or a
 * raw Nest error is caught.
 */
describe('Error-envelope conformance across status classes (e2e, §25.1)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let csrf: string;
  const host = `env-${randomUUID().slice(0, 6)}.localhost`;
  const email = 'owner@env.pk';
  const password = 'Owner!Secret12';

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const authGet = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);
  const authPost = (p: string, body: object = {}) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).set('Idempotency-Key', randomUUID()).send(body);

  const assertEnvelope = (res: request.Response, status: number, code: string) => {
    expect(res.status).toBe(status);
    expect(Object.keys(res.body)).toEqual(['error']); // no leakage beside the envelope
    expect(res.body.error.code).toBe(code);
    expect(typeof res.body.error.message).toBe('string');
    expect(res.body.error.message.length).toBeGreaterThan(0);
    expect(res.body).not.toHaveProperty('stack');
    expect(res.body.error).not.toHaveProperty('stack');
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    platform = app.get(PlatformPrismaService);

    const prov = await app.get(ProvisioningService, { strict: false }).provisionSchool({ name: 'Envelope School', subdomain: host.split('.')[0], ownerEmail: email, ownerPassword: password });
    schoolId = prov.schoolId;
    cookies = (await loginRequest(server(), host, email, password)).headers['set-cookie'] as unknown as string[]; // deliberately NOT MFA-enrolled
    csrf = csrfOf(cookies);
    await authPost('/api/v1/classes', { campusId: prov.campusId, name: 'Grade 1', order: 1 });
  }, 60_000);

  afterAll(async () => {
    if (schoolId) await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('400 — a malformed UUID param', async () => {
    assertEnvelope(await authGet('/api/v1/students/not-a-uuid'), 400, 'VALIDATION_FAILED');
  });

  it('401 — an unauthenticated request', async () => {
    const res = await request(server()).get('/api/v1/students').set('Host', host);
    expect(res.status).toBe(401);
    expect(Object.keys(res.body)).toEqual(['error']);
    expect(typeof res.body.error.code).toBe('string');
    expect(res.body.error.code.length).toBeGreaterThan(0);
  });

  it('403 — a sensitive action behind the MFA-enrolment gate', async () => {
    assertEnvelope(await authPost(`/api/v1/users/${NIL}/reset-password`, { password: 'Reset!Secret12Aa' }), 403, 'MFA_ENROLMENT_REQUIRED');
  });

  it('404 — a well-formed id that does not exist', async () => {
    assertEnvelope(await authGet(`/api/v1/students/${NIL}`), 404, 'NOT_FOUND');
  });

  it('409 — a duplicate unique value', async () => {
    const campusId = (await authGet('/api/v1/campuses')).body[0].id;
    assertEnvelope(await authPost('/api/v1/classes', { campusId, name: 'Grade 1', order: 1 }), 409, 'CONFLICT');
  });

  it('422 — a cross-field rule violation', async () => {
    assertEnvelope(await authPost('/api/v1/academic-years', { name: 'Backwards', startDate: '2029-04-01', endDate: '2028-03-31' }), 422, 'VALIDATION_FAILED');
  });
});
