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
 * Bank-statement reconciliation — wired path (§2 QA nicety, Fees Gaps Register). The pure matchers
 * (parseAmount/parseDate/fingerprintOf/scoreClaim) are unit-tested in reconciliation.service.spec.ts;
 * this exercises what only a database can prove: preview/import over HTTP against real PENDING claims,
 * the EXACT/STRONG tiers end to end, noise filtering, the fingerprint DEDUP on re-import, the
 * unexplained-credits ledger, inbound CSV-injection inertness, and the mapping-error 422.
 *
 * Statement routes are OWNER_ADMIN/ACCOUNTANT and NOT MFA-gated (they store evidence, they never
 * verify), so the provisioned owner drives them without enrolling two-factor.
 */
describe('Bank-statement reconciliation (e2e, §12 Fees Gaps)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let csrf: string;
  let invoiceA: string;
  let invoiceB: string;

  const sub = `rec-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const email = 'owner@rec.pk';
  const password = 'Owner!Secret12';
  const PAID_ON = '2026-07-10';

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object = {}) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).send(b);
  const get = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

  /** Standard column map for the "our headers" CSVs below. */
  const COLS = { valueDate: 'Value Date', credit: 'Credit', narration: 'Narration', reference: 'Reference', counterparty: 'Payer' };
  const preview = (csv: string, columns: object = COLS, bankLabel = 'Meezan — main') =>
    post('/api/v1/fees/statements/preview', { bankLabel, csv, columns });
  const importStmt = (csv: string, columns: object = COLS, bankLabel = 'Meezan — main') =>
    post('/api/v1/fees/statements', { bankLabel, csv, columns });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const prov = await app.get(ProvisioningService, { strict: false }).provisionSchool({
      name: 'Recon School', subdomain: sub, ownerEmail: email, ownerPassword: password,
    });
    schoolId = prov.schoolId;
    const login = await loginRequest(server(), host, email, password);
    cookies = login.headers['set-cookie'] as unknown as string[];
    csrf = csrfOf(cookies);

    const yearId = (await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true })).body.id;
    const klass = (await post('/api/v1/classes', { campusId: prov.campusId, name: 'Grade 1', order: 1 })).body;
    const section = await post('/api/v1/sections', { classId: klass.id, name: 'A' });
    const { admit } = await admissionController(app, platform, schoolId, host, prov.campusId);
    const s1 = await admit({
      fullName: 'Ahmed Khan', gender: 'MALE', dateOfBirth: '2020-05-10', campusId: prov.campusId, classId: klass.id, sectionId: section.body.id,
      guardian: { mode: 'CREATE', fullName: 'Bilal Khan', phone: '03007650001', relation: 'FATHER' },
    });
    const s2 = await admit({
      fullName: 'Sara Malik', gender: 'FEMALE', dateOfBirth: '2020-06-10', campusId: prov.campusId, classId: klass.id, sectionId: section.body.id,
      guardian: { mode: 'CREATE', fullName: 'Imran Malik', phone: '03007650002', relation: 'FATHER' },
    });

    // Tuition 1000/month → each student is invoiced 1000 for July 2026.
    const head = await post('/api/v1/fee-heads', { name: 'Tuition' });
    await post('/api/v1/fee-structures', { campusId: prov.campusId, classId: klass.id, feeHeadId: head.body.id, academicYearId: yearId, amount: 1000, frequency: 'MONTHLY' });
    await post('/api/v1/fees/invoice-batches', { classId: klass.id, month: 7, year: 2026 });
    invoiceA = (await get(`/api/v1/fees/invoices?studentId=${s1.body.studentId}&month=7&year=2026`)).body.data[0].id;
    invoiceB = (await get(`/api/v1/fees/invoices?studentId=${s2.body.studentId}&month=7&year=2026`)).body.data[0].id;

    // Two PENDING bank-transfer claims the statement will corroborate.
    await post('/api/v1/fees/claims', { invoiceId: invoiceA, amount: 1000, method: 'BANK_TRANSFER', transactionRef: 'HBLTRX1001', paidOn: PAID_ON, autoVerify: false });
    await post('/api/v1/fees/claims', { invoiceId: invoiceB, amount: 1000, method: 'BANK_TRANSFER', transactionRef: 'MZN2002', paidOn: PAID_ON, autoVerify: false });
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  // A statement with: an EXACT ref line, a STRONG (ref-in-narration) line, an unexplained credit,
  // and three noise rows (a debit, a zero, and a broken date) that must all be filtered out.
  const STATEMENT = [
    'Value Date,Credit,Reference,Narration,Payer',
    `${PAID_ON},1000,HBLTRX1001,July tuition,Bilal Khan`,       // EXACT — reference column
    `${PAID_ON},1000,,paid via MZN2002 jazakallah,Imran Malik`, // STRONG — ref in narration
    `${PAID_ON},1000,,Anonymous cash deposit,`,                 // matched by nothing identifying → unexplained
    `2026-07-11,-500,,Bank service charge,`,                    // debit → skipped
    `2026-07-11,0,,Nil movement,`,                              // zero → skipped
    `not-a-date,1000,XREF,Broken row,`,                         // unparseable date → skipped
  ].join('\n');

  it('preview: matches EXACT + STRONG, leaves the anonymous credit unexplained, filters noise', async () => {
    const res = await preview(STATEMENT);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ committed: false, parsed: 3, matched: 2, unexplained: 1 });

    const byTier = res.body.rows.map((r: { match?: { confidence: string } }) => r.match?.confidence ?? null);
    expect(byTier).toContain('EXACT');
    expect(byTier).toContain('STRONG');
    expect(byTier.filter((t: string | null) => t === null)).toHaveLength(1); // the anonymous credit
    const exact = res.body.rows.find((r: { match?: { reason: string } }) => r.match?.reason?.includes('HBLTRX1001'));
    expect(exact.match.reason).toMatch(/matches the statement/i);
  });

  it('preview: 422 when the mapped credit column is not in the file', async () => {
    const res = await preview(STATEMENT, { ...COLS, credit: 'Nonexistent' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.message).toMatch(/credit column/i);
  });

  it('preview: works against a different bank whose headers are mapped by name', async () => {
    const hbl = ['Txn Date,Deposit,Remarks', `${PAID_ON},1000,ref HBLTRX1001 tuition`].join('\n');
    const res = await preview(hbl, { valueDate: 'Txn Date', credit: 'Deposit', narration: 'Remarks', reference: '', counterparty: '' });
    expect(res.status).toBe(200);
    expect(res.body.parsed).toBe(1);
    // The reference lives in the narration → STRONG.
    expect(res.body.rows[0].match?.confidence).toBe('STRONG');
  });

  it('import: stores the credit lines and records the matches (idempotent on re-upload)', async () => {
    const first = await importStmt(STATEMENT);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ committed: true, parsed: 3, matched: 2, stored: 3 });

    // Re-uploading an overlapping range is the NORMAL case — the fingerprint makes it safe: nothing new.
    const again = await importStmt(STATEMENT);
    expect(again.body).toMatchObject({ parsed: 3, stored: 0 });
  });

  it('unexplained: surfaces the credit no claim explains, with its bank label', async () => {
    const res = await get('/api/v1/fees/statements/unexplained?days=3650');
    expect(res.status).toBe(200);
    const anon = res.body.find((u: { narration: string }) => /anonymous cash deposit/i.test(u.narration));
    expect(anon).toBeTruthy();
    expect(Number(anon.amount)).toBe(1000);
    expect(anon.bankLabel).toBe('Meezan — main');
  });

  it('inbound CSV injection is inert — a formula-shaped narration is stored as text, not run', async () => {
    const evil = ['Value Date,Credit,Reference,Narration,Payer', `${PAID_ON},2500,,=cmd()|calc danger,Somebody`].join('\n');
    const imp = await importStmt(evil);
    expect(imp.status).toBe(201);
    const res = await get('/api/v1/fees/statements/unexplained?days=3650');
    const row = res.body.find((u: { amount: string }) => Number(u.amount) === 2500);
    // Stored verbatim — inbound data is never evaluated; the value survives as-is for the office to read.
    expect(row.narration).toBe('=cmd()|calc danger');
  });
});
