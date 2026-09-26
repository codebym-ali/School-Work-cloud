import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { admissionController } from './support/admission';
import { destroyTenant } from './support/tenant';
import { loginRequest } from './support/login';

/**
 * Fee advances drawn down over successive months (§12, §2 QA nicety). A guardian deposits standing
 * credit; each month's invoice batch consumes it automatically until it runs out, at which point the
 * next invoice is left partly/entirely unpaid. This is the "advance-consumption over time" case the
 * unit tests can't reach — it needs real invoice generation across cycles and the guardian-credit
 * ledger that recompute and the integrity check depend on.
 */
describe('Fee advance consumption over cycles (e2e, §12)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let csrf: string;
  let classId: string;
  let studentId: string;
  let parentId: string;

  const sub = `adv-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const email = 'owner@adv.pk';
  const password = 'Owner!Secret12';

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object = {}, headers: Record<string, string> = {}) => {
    let r = request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(b);
  };
  const get = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

  const balance = async (): Promise<number> => Number((await get(`/api/v1/fees/advances?parentId=${parentId}`)).body.balance);
  const invoiceFor = async (month: number) => {
    await post('/api/v1/fees/invoice-batches', { classId, month, year: 2026 });
    return (await get(`/api/v1/fees/invoices?studentId=${studentId}&month=${month}&year=2026`)).body.data[0];
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const prov = await app.get(ProvisioningService, { strict: false }).provisionSchool({
      name: 'Advance School', subdomain: sub, ownerEmail: email, ownerPassword: password,
    });
    schoolId = prov.schoolId;
    const login = await loginRequest(server(), host, email, password);
    cookies = login.headers['set-cookie'] as unknown as string[];
    csrf = csrfOf(cookies);

    const yearId = (await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true })).body.id;
    const klass = (await post('/api/v1/classes', { campusId: prov.campusId, name: 'Grade 1', order: 1 })).body;
    classId = klass.id;
    const section = await post('/api/v1/sections', { classId, name: 'A' });
    const { admit } = await admissionController(app, platform, schoolId, host, prov.campusId);
    const student = await admit({
      fullName: 'Zara Ali', gender: 'FEMALE', dateOfBirth: '2020-05-10', campusId: prov.campusId, classId, sectionId: section.body.id,
      guardian: { mode: 'CREATE', fullName: 'Kamran Ali', phone: '03007650009', relation: 'FATHER' },
    });
    studentId = student.body.studentId;
    parentId = student.body.parentId;

    // Tuition 1000/month.
    const head = await post('/api/v1/fee-heads', { name: 'Tuition' });
    await post('/api/v1/fee-structures', { campusId: prov.campusId, classId, feeHeadId: head.body.id, academicYearId: yearId, amount: 1000, frequency: 'MONTHLY' });
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('deposits standing credit, and the deposit is idempotent under one key', async () => {
    const key = randomUUID();
    const first = await post('/api/v1/fees/advances', { parentId, amount: 2500 }, { 'Idempotency-Key': key });
    expect(first.status).toBe(201);
    expect(Number(first.body.balance)).toBe(2500);

    // Same key + body → no second credit (a retried request must not double the balance).
    const replay = await post('/api/v1/fees/advances', { parentId, amount: 2500 }, { 'Idempotency-Key': key });
    expect(Number(replay.body.balance)).toBe(2500);
    expect(await balance()).toBe(2500);
  });

  it('a deposit without an Idempotency-Key is refused', async () => {
    const res = await post('/api/v1/fees/advances', { parentId, amount: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/idempotency-key/i);
  });

  it('month 1 & 2 invoices are fully paid from the advance, drawing it down 2500 → 1500 → 500', async () => {
    const july = await invoiceFor(7);
    expect(july.status).toBe('PAID');
    expect(Number(july.paidAmount)).toBe(1000);
    expect(await balance()).toBe(1500);

    const august = await invoiceFor(8);
    expect(august.status).toBe('PAID');
    expect(await balance()).toBe(500);
  });

  it('month 3 exhausts the advance — partial payment, balance to zero', async () => {
    const september = await invoiceFor(9);
    expect(Number(september.paidAmount)).toBe(500); // only 500 left to apply
    expect(september.status).toBe('PARTIAL');
    expect(await balance()).toBe(0);
  });

  it('month 4 has no advance left — the invoice is generated unpaid', async () => {
    const october = await invoiceFor(10);
    expect(Number(october.paidAmount)).toBe(0);
    expect(october.status).not.toBe('PAID');
    expect(await balance()).toBe(0);
  });
});
