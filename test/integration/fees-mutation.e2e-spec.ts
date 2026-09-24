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
 * Fees mutation — the §1 rules the concurrency/money/fuzz suites don't reach: discount bounds, copy-a-plan
 * preconditions, and that a discount actually reduces a generated invoice (not just stored). The payment
 * engine itself is covered by money-integrity (C5) + idempotency-concurrency (C4); this is the setup side.
 */
describe('Fees mutation — discounts & plan copy (e2e, §12)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let csrf: string;
  let classId: string;
  let emptyClassId: string;
  let studentId: string;
  let yearId: string;
  const host = `feem-${randomUUID().slice(0, 6)}.localhost`;
  const email = 'owner@feem.pk';
  const password = 'Owner!Secret12';

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, body: object = {}) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).set('Idempotency-Key', randomUUID()).send(body);
  const get = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);
  const invoiceTotal = async (month: number): Promise<number> => {
    await post('/api/v1/fees/invoice-batches', { classId, month, year: 2026 });
    const inv = (await get(`/api/v1/fees/invoices?studentId=${studentId}&month=${month}&year=2026`)).body.data[0];
    return Number(inv.totalAmount);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    platform = app.get(PlatformPrismaService);

    const prov = await app.get(ProvisioningService, { strict: false }).provisionSchool({ name: 'FeeMut School', subdomain: host.split('.')[0], ownerEmail: email, ownerPassword: password });
    schoolId = prov.schoolId;
    cookies = (await loginRequest(server(), host, email, password)).headers['set-cookie'] as unknown as string[];
    csrf = csrfOf(cookies);

    yearId = (await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true })).body.id;
    classId = (await post('/api/v1/classes', { campusId: prov.campusId, name: 'Grade 1', order: 1 })).body.id;
    emptyClassId = (await post('/api/v1/classes', { campusId: prov.campusId, name: 'Grade 2', order: 2 })).body.id; // no fee plan
    const sectionId = (await post('/api/v1/sections', { classId, name: 'A' })).body.id;
    const { admit } = await admissionController(app, platform, schoolId, host, prov.campusId);
    studentId = (await admit({
      fullName: 'Fee Child', gender: 'MALE', dateOfBirth: '2018-05-10', campusId: prov.campusId, classId, sectionId,
      guardian: { mode: 'CREATE', fullName: 'Fee Guardian', phone: '03007654321', relation: 'FATHER' },
    })).body.studentId;
    const head = await post('/api/v1/fee-heads', { name: 'Tuition' });
    await post('/api/v1/fee-structures', { campusId: prov.campusId, classId, feeHeadId: head.body.id, academicYearId: yearId, amount: 1000, frequency: 'MONTHLY' });
  }, 120_000);

  afterAll(async () => {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    if (schoolId) await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('refuses a percent discount above 100 (422) but accepts exactly 100', async () => {
    const tooHigh = await post('/api/v1/discounts', { studentId, type: 'PERCENT', value: 150, reason: 'typo' });
    expect(tooHigh.status).toBe(422);
    expect(tooHigh.body.error.code).toBe('VALIDATION_FAILED');

    const boundary = await post('/api/v1/discounts', { studentId, type: 'PERCENT', value: 100, reason: 'full scholarship' });
    expect(boundary.status).toBe(201);
    // Revoke it so it doesn't skew the "discount reduces invoice" test below.
    await post(`/api/v1/discounts/${boundary.body.id}/revoke`);
  });

  it('refuses copying a fee plan from a class that has none (422)', async () => {
    const res = await post('/api/v1/fee-structures/copy', { fromClassId: emptyClassId, fromAcademicYearId: yearId, toClassIds: [classId] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('a percent discount actually reduces the next generated invoice', async () => {
    const undiscounted = await invoiceTotal(6); // before any active discount
    expect(undiscounted).toBe(1000);

    const disc = await post('/api/v1/discounts', { studentId, type: 'PERCENT', value: 20, reason: 'sibling' });
    expect(disc.status).toBe(201);

    const discounted = await invoiceTotal(7); // generated after the discount is active
    expect(discounted).toBeLessThan(undiscounted); // the concession is applied at generation, not just stored
  });
});
