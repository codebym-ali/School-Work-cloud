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
 * Withdrawing a student (GAP-04).
 *
 * The workflow existed; these cases pin what was wrong with it, found while building its screen:
 *  - invoices already raised for months AFTER leaving stayed owed, aged into OVERDUE, and put a family
 *    that left owing nothing on the defaulter list;
 *  - an invoice for a month that had not begun blocked withdrawal as though it were owed (B6);
 *  - overriding fee clearance still issued a certificate saying all fee dues were cleared;
 *  - every withdrawal was audited as a fee override, so the log could not say who let a student leave owing.
 *
 * ⚠️ Months are chosen against the real date. Today is inside the 2026-27 year: JULY 2026 has begun and is
 * owed; NOVEMBER 2026 has not. Invoice generation refuses months outside the academic year, and a
 * future-dated invoice is never a defaulter, so both traps are avoided by construction.
 */
describe('Student withdrawal (e2e, GAP-04)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let campusId: string;
  let yearId: string;
  let feeHeadId: string;
  let admit: (dto: object) => request.Test;

  const sub = `wdr-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@wdr.pk', password: 'Owner!Secret12' };
  const PAST = { month: 7, year: 2026 };   // begun — owed
  const FUTURE = { month: 11, year: 2026 }; // not begun — not owed

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send(b);
  const get = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

  let n = 0;
  /** A student alone in their own class, so a batch bills exactly them, for the given months. */
  async function studentBilledFor(months: Array<{ month: number; year: number }>) {
    n += 1;
    const classId = (await post('/api/v1/classes', { campusId, name: `W-${n}`, order: 100 + n })).body.id;
    const sectionId = (await post('/api/v1/sections', { classId, name: 'A' })).body.id;
    await post('/api/v1/fee-structures', { campusId, classId, feeHeadId, academicYearId: yearId, amount: 2000, frequency: 'MONTHLY' });
    const admitted = await admit({
      fullName: `Leaver ${n}`, gender: 'MALE', dateOfBirth: '2014-05-05', campusId, classId, sectionId,
      guardian: { mode: 'CREATE', fullName: `Parent ${n}`, phone: `0333555${String(1000 + n)}`, relation: 'FATHER' },
    });
    expect(admitted.status).toBe(201);
    // Enrolled well before the months being billed, as a real student would be.
    await platform.studentEnrollment.update({ where: { id: admitted.body.enrollmentId }, data: { startedAt: new Date('2026-04-01') } });
    for (const m of months) expect((await post('/api/v1/fees/invoice-batches', { classId, ...m })).status).toBeLessThan(300);
    return admitted.body.studentId as string;
  }
  const invoiceFor = (studentId: string, m: { month: number; year: number }) =>
    platform.feeInvoice.findFirstOrThrow({ where: { studentId, month: m.month, year: m.year } });
  const auditsFor = async (studentId: string) =>
    (await platform.auditLog.findMany({ where: { schoolId, entityId: studentId } })).map((a) => a.action);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    platform = app.get(PlatformPrismaService);

    const prov = await app.get(ProvisioningService, { strict: false })
      .provisionSchool({ name: 'Withdrawal School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;
    campusId = prov.campusId;
    cookies = (await loginRequest(server(), host, owner.email, owner.password)).headers['set-cookie'] as unknown as string[];

    yearId = (await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true })).body.id;
    feeHeadId = (await post('/api/v1/fee-heads', { name: 'Tuition' })).body.id;
    ({ admit } = await admissionController(app, platform, schoolId, host, campusId));
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('withdraws a student whose only invoice is for a month that has not begun — no override needed', async () => {
    const studentId = await studentBilledFor([FUTURE]);

    const res = await post(`/api/v1/students/${studentId}/withdraw`, { reason: 'Family relocated to Karachi' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'WITHDRAWN', leftOwing: false, waivedInvoicesAfterLeaving: 1 });
    expect(res.body.feeClearanceId).toEqual(expect.any(String));

    // The November invoice was for a month after leaving: closed, with the reason on the waiver line.
    const nov = await invoiceFor(studentId, FUTURE);
    expect(nov.status).toBe('WAIVED');
    const line = await platform.feeInvoiceItem.findFirst({ where: { invoiceId: nov.id, type: 'WAIVER' } });
    expect(line?.description).toMatch(/Withdrawn on .*not enrolled for this period/);

    const actions = await auditsFor(studentId);
    expect(actions).toContain('STUDENT_WITHDRAWN');
    expect(actions).not.toContain('WITHDRAWAL_FEE_OVERRIDE');
  });

  it('refuses without an override when a begun month is owed — and waives nothing', async () => {
    const studentId = await studentBilledFor([PAST, FUTURE]);

    const res = await post(`/api/v1/students/${studentId}/withdraw`, { reason: 'Left' });
    expect(res.status).toBe(409);
    // ⚠️ The future invoice is waived inside the same request before the fee check refuses it. The refusal
    // must roll that back — a refused withdrawal that quietly wrote off a month would be a leak.
    const nov = await invoiceFor(studentId, FUTURE);
    expect(nov.status).not.toBe('WAIVED');
    expect((await platform.student.findUniqueOrThrow({ where: { id: studentId } })).isActive).toBe(true);
    // And the audit log does not record a waiver that never happened: audit rows are written through the
    // same transactional client, so they roll back with the request.
    expect(await platform.auditLog.count({ where: { schoolId, entityId: nov.id, action: 'FEE_WAIVED' } })).toBe(0);
  });

  it('lets the owner withdraw a student who owes, without pretending the dues are cleared', async () => {
    const studentId = await studentBilledFor([PAST, FUTURE]);

    const res = await post(`/api/v1/students/${studentId}/withdraw`, { reason: 'Hardship — owner approved', overrideFeeClearance: true });
    expect(res.status).toBe(201);
    // No "has cleared all outstanding fee dues" certificate for a student who has not.
    expect(res.body).toMatchObject({ feeClearanceId: null, leftOwing: true, waivedInvoicesAfterLeaving: 1 });
    expect(res.body.leavingCertId).toEqual(expect.any(String));

    // July stays owed — withdrawal is not a write-off (D6). Only the month after leaving is closed.
    expect((await invoiceFor(studentId, PAST)).status).not.toBe('WAIVED');
    expect((await invoiceFor(studentId, FUTURE)).status).toBe('WAIVED');

    const actions = await auditsFor(studentId);
    expect(actions).toEqual(expect.arrayContaining(['STUDENT_WITHDRAWN', 'WITHDRAWAL_FEE_OVERRIDE']));
  });

  it('uses the office-set leaving date — both to end the enrolment and to decide which months were after it', async () => {
    // Left at the end of August; the September invoice was raised anyway. September has BEGUN by today, but
    // it began after the student left, so it is not owed.
    const SEP = { month: 9, year: 2026 };
    const studentId = await studentBilledFor([SEP]);

    const res = await post(`/api/v1/students/${studentId}/withdraw`, { reason: 'Notice given in August', leavingDate: '2026-08-31' });
    expect(res.status).toBe(201);
    expect((await invoiceFor(studentId, SEP)).status).toBe('WAIVED');

    const enrolment = await platform.studentEnrollment.findFirstOrThrow({ where: { studentId } });
    expect(enrolment.status).toBe('WITHDRAWN');
    expect(enrolment.endedAt?.toISOString().slice(0, 10)).toBe('2026-08-31');
  });

  it('refuses a leaving date in the future', async () => {
    const studentId = await studentBilledFor([]);
    const res = await post(`/api/v1/students/${studentId}/withdraw`, { reason: 'Early', leavingDate: '2099-01-01' });
    expect(res.status).toBe(422);
  });

  it('keeps a withdrawn student off the defaulter list for months after they left', async () => {
    const studentId = await studentBilledFor([FUTURE]);
    // ⚠️ Asserted, not assumed. Without this line the case passed against the OLD logic for the wrong
    // reason: the withdrawal was refused, the student stayed enrolled, and so was never a defaulter.
    expect((await post(`/api/v1/students/${studentId}/withdraw`, { reason: 'Left' })).status).toBe(201);
    expect((await invoiceFor(studentId, FUTURE)).status).toBe('WAIVED');
    // Even once November is long past, a waived invoice is not owed — the defaulter query only reads owing statuses.
    const defaulters = await get('/api/v1/fees/defaulters');
    expect(defaulters.status).toBe(200);
    expect(JSON.stringify(defaulters.body)).not.toContain(studentId);
  });
});
