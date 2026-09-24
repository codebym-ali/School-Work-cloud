import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { SMS_QUEUE } from '../../apps/api/src/modules/comms/sms/sms.types';
import { admissionController } from './support/admission';
import { destroyTenant } from './support/tenant';
import { loginRequest } from './support/login';

/**
 * Report exports (QA plan §7): a CSV export must (a) carry exactly the rows the JSON view carries
 * (export-parity — the file the office keeps agrees with the screen), and (b) be safe to open — a cell that
 * begins with a formula trigger (`=`, `+`, `-`, `@`) must be neutralised so Excel/Sheets render it as text
 * instead of executing it (CSV formula injection via a crafted class/student name).
 */
describe('Report exports — parity & CSV-injection safety (e2e, §28)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let csrf: string;
  const host = `rpt-${randomUUID().slice(0, 6)}.localhost`;
  const email = 'owner@rpt.pk';
  const password = 'Owner!Secret12';

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, body: object = {}) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).set('Idempotency-Key', randomUUID()).send(body);
  const get = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    platform = app.get(PlatformPrismaService);

    const prov = await app.get(ProvisioningService, { strict: false }).provisionSchool({ name: 'Report School', subdomain: host.split('.')[0], ownerEmail: email, ownerPassword: password });
    schoolId = prov.schoolId;
    cookies = (await loginRequest(server(), host, email, password)).headers['set-cookie'] as unknown as string[];
    csrf = csrfOf(cookies);

    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    // A class whose NAME is a spreadsheet formula — the injection vector a crafted admission could plant.
    const evilClass = (await post('/api/v1/classes', { campusId: prov.campusId, name: '=1+1', order: 1 })).body.id;
    const plainClass = (await post('/api/v1/classes', { campusId: prov.campusId, name: 'Grade 2', order: 2 })).body.id;
    const evilSec = (await post('/api/v1/sections', { classId: evilClass, name: 'A' })).body.id;
    const plainSec = (await post('/api/v1/sections', { classId: plainClass, name: 'A' })).body.id;
    const { admit } = await admissionController(app, platform, schoolId, host, prov.campusId);
    await admit({ fullName: 'C One', gender: 'MALE', dateOfBirth: '2018-05-10', campusId: prov.campusId, classId: evilClass, sectionId: evilSec, guardian: { mode: 'CREATE', fullName: 'G1', phone: '03007650001', relation: 'FATHER' } });
    await admit({ fullName: 'C Two', gender: 'MALE', dateOfBirth: '2018-05-10', campusId: prov.campusId, classId: plainClass, sectionId: plainSec, guardian: { mode: 'CREATE', fullName: 'G2', phone: '03007650002', relation: 'FATHER' } });
  }, 120_000);

  afterAll(async () => {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    if (schoolId) await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('class-strength CSV carries exactly the rows of the JSON view (export-parity)', async () => {
    const json = await get('/api/v1/reports/class-strength?format=json');
    expect(json.status).toBe(200);
    const rows = json.body as unknown[];
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const csv = await get('/api/v1/reports/class-strength?format=csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('attachment');
    const lines = csv.text.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(rows.length + 1); // one header + one line per JSON row
  });

  it('neutralises a formula-leading cell so the CSV is safe to open', async () => {
    const csv = (await get('/api/v1/reports/class-strength?format=csv')).text;
    // The class named "=1+1" must appear neutralised ('=1+1), never as a bare formula a cell could evaluate.
    expect(csv).toContain("'=1+1");
    for (const line of csv.split('\n')) expect(line.startsWith('=1+1')).toBe(false);
    expect(csv).not.toMatch(/(^|,)=1\+1(,|$)/m); // no unguarded =1+1 in any field position
  });
});
