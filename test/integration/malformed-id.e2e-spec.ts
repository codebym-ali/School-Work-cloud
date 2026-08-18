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
 * A malformed id is the caller's mistake, and must read like one.
 *
 * ⚠️ **Every `:id` route in the product answered 500 to a bad id.** `ParseUUIDPipe` was on exactly
 * **4 of 85** parameters, so everywhere else the raw string reached Prisma and came back as
 * `Inconsistent column data: Error creating UUID` — a 500, an error-rate alert, and a stack trace,
 * for what is a 400.
 *
 * It is not a cosmetic status code. This has already cost real debugging time in this repo by making
 * a **bad test fixture read as a broken feature**: a 500 says "the server is broken, investigate the
 * server", and the server was fine. That is the specific failure this file exists to prevent
 * recurring.
 *
 * The routes below are picked to span the pipeline — a plain admin read, a nested resource, a
 * delete, and an ownership-scoped portal route — because the pipe has to be on the *parameter*, and
 * one controller getting it says nothing about the other seventeen.
 */
describe('Malformed ids (e2e)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let csrf: string;

  const sub = `mid-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@mid.pk', password: 'Owner!Secret12' };

  const server = () => app.getHttpServer();
  const get = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);
  const del = (p: string) =>
    request(server()).delete(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const prov = await app.get(ProvisioningService, { strict: false }).provisionSchool({
      name: 'Malformed Id School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password,
    });
    schoolId = prov.schoolId;

    const res = await loginRequest(server(), host, owner.email, owner.password);
    cookies = res.headers['set-cookie'] as unknown as string[];
    csrf = (cookies.find((c) => c.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  /**
   * One per module family, so a regression in any single controller is visible.
   *
   * ⚠️ Each path is a route that ACTUALLY EXISTS — checked, not assumed. A first draft listed
   * `GET /classes/:id`, `GET /exams/:id` and `GET /documents/:id`, none of which are real: they
   * returned 404 because nothing matched, which would have made three of these cases permanently
   * green regardless of whether the pipe was there at all.
   */
  const READS: Array<[string, string]> = [
    ['a student', '/api/v1/students/not-a-uuid'],
    ['a class-test', '/api/v1/class-tests/not-a-uuid'],
    ['a section timetable', '/api/v1/timetable/section/not-a-uuid'],
    ['a bell schedule', '/api/v1/bell-schedules/not-a-uuid'],
    ['an invoice', '/api/v1/fees/invoices/not-a-uuid'],
    ['a staff member', '/api/v1/staff/not-a-uuid'],
    ['exam results', '/api/v1/exams/not-a-uuid/results'],
    ['a document url', '/api/v1/documents/not-a-uuid/url'],
  ];

  it.each(READS)('reads %s with a malformed id → 400, never 500', async (_label, path) => {
    const res = await get(path);
    expect(res.status).toBe(400);
    // The assertion that matters is the ABSENCE of 500. A 404 would be defensible in isolation, but
    // it would mean the id reached a lookup — and the point is that a syntactically impossible id
    // never gets that far.
    expect(res.status).not.toBe(500);
  });

  it('deletes with a malformed id → 400, so a typo cannot look like a server fault', async () => {
    const res = await del('/api/v1/subjects/not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('still resolves a WELL-FORMED id that matches nothing → 404, not 400', async () => {
    // ⚠️ The half that stops this being a blunt instrument. If the pipe were somehow rejecting
    // valid uuids too, every test above would still pass — they only assert 400. This is the case
    // that fails if the fix goes too far.
    const res = await get(`/api/v1/students/${randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it('leaves non-uuid path parameters alone', async () => {
    // `fee-link` takes an opaque TOKEN, not a uuid, and is public by design. Applying the pipe to
    // every `@Param` in the codebase would have made the guardian fee link permanently 400 — the
    // reason this sweep is parameter-name-driven rather than blanket.
    const res = await request(server()).get('/api/v1/fee-link/some-opaque-token').set('Host', host);
    expect(res.status).not.toBe(400);
  });
});
