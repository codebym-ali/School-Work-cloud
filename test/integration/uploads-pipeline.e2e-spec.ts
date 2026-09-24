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
 * Upload pipeline (QA plan §5, blueprint §22.6): presigned PUT to a quarantine prefix → confirm validates
 * the MIME allowlist + magic bytes, then promotes the object out of quarantine. ClamAV is opt-in and off in
 * the test env, so the AV branch is covered by clamav.service.spec; this exercises everything else against
 * real MinIO:
 *   • a disallowed MIME is refused up front (422) — no presign issued;
 *   • bytes that don't match the declared type → 422 "content does not match" (the magic-byte gate);
 *   • a real PNG round-trips: request → PUT → confirm → promoted fileKey;
 *   • a confirm for a key outside the caller's own quarantine prefix → 403 (tenant/self boundary);
 *   • a confirm for a well-formed but non-existent key → 404.
 */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

describe('Upload pipeline — allowlist, magic bytes, promotion (e2e, §22.6)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let csrf: string;
  const host = `upl-${randomUUID().slice(0, 6)}.localhost`;
  const email = 'owner@upl.pk';
  const password = 'Owner!Secret12';

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, body: object = {}) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).send(body);
  const putBytes = (url: string, body: Buffer, contentType: string) =>
    fetch(url, { method: 'PUT', body, headers: { 'content-type': contentType } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    platform = app.get(PlatformPrismaService);

    const prov = await app.get(ProvisioningService, { strict: false }).provisionSchool({ name: 'Upload School', subdomain: host.split('.')[0], ownerEmail: email, ownerPassword: password });
    schoolId = prov.schoolId;
    cookies = (await loginRequest(server(), host, email, password)).headers['set-cookie'] as unknown as string[];
    csrf = csrfOf(cookies);
  }, 60_000);

  afterAll(async () => {
    if (schoolId) await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('refuses a disallowed MIME at request time (422, no presign issued)', async () => {
    const res = await post('/api/v1/uploads', { filename: 'evil.exe', mimeType: 'application/x-msdownload' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects bytes that do not match the declared type (422 magic-byte gate)', async () => {
    const req = await post('/api/v1/uploads', { filename: 'photo.png', mimeType: 'image/png' });
    expect(req.status).toBe(201);
    const put = await putBytes(req.body.url, Buffer.from('this is not a png'), 'image/png');
    expect(put.ok).toBe(true);
    const confirm = await post('/api/v1/uploads/confirm', { key: req.body.key, mimeType: 'image/png' });
    expect(confirm.status).toBe(422);
    expect(confirm.body.error.code).toBe('VALIDATION_FAILED');
  }, 60_000);

  it('round-trips a real PNG: request → PUT → confirm → promoted out of quarantine', async () => {
    const req = await post('/api/v1/uploads', { filename: 'avatar.png', mimeType: 'image/png' });
    expect(req.status).toBe(201);
    expect(req.body.key).toContain(`quarantine/${schoolId}/`);
    const put = await putBytes(req.body.url, PNG, 'image/png');
    expect(put.ok).toBe(true);
    const confirm = await post('/api/v1/uploads/confirm', { key: req.body.key, mimeType: 'image/png' });
    expect(confirm.status).toBe(201);
    expect(confirm.body.fileKey).toContain(`uploads/${schoolId}/`);
    expect(confirm.body.fileKey).not.toContain('quarantine/');
  }, 60_000);

  it('refuses to confirm a key outside the caller’s own quarantine prefix (403)', async () => {
    const res = await post('/api/v1/uploads/confirm', { key: `quarantine/00000000-0000-0000-0000-000000000000/${randomUUID()}-x.png`, mimeType: 'image/png' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 404 confirming a well-formed key that was never uploaded', async () => {
    const res = await post('/api/v1/uploads/confirm', { key: `quarantine/${schoolId}/${randomUUID()}-ghost.png`, mimeType: 'image/png' });
    expect(res.status).toBe(404);
  }, 60_000);
});
