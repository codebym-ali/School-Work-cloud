import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { destroyTenant } from './support/tenant';

/**
 * Staff attendance marking (§9/§13).
 *
 * `POST /staff-attendance/bulk` previously validated NOTHING — any date including the future,
 * any staff member in any campus, no working-day check, no audit — while returning the
 * partial-failure shape (§25.3) it never populated. These rows feed `payroll.absentDays()`
 * straight into the salary deduction, so each of those was a way to move somebody's pay.
 */
describe('Staff attendance marking (e2e)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;

  let campusA: string;
  let campusB: string;
  let ownerCookies: string[];
  let ownerCsrf: string;
  let adminCookies: string[]; // CAMPUS_ADMIN bound to campus A
  let adminCsrf: string;
  let ownerUserId: string;

  let staffA: string; // campus A, joined long ago
  let staffB: string; // campus B
  let newJoiner: string; // campus A, joins today

  const sub = `sat-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@sat.pk', password: 'Owner!Secret12' };
  const admin = { email: 'campadmin@sat.pk', password: 'Admin!Secret12' };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const authed = (method: 'get' | 'post', p: string, cookies: string[], csrf?: string) => {
    let r = request(server())[method](p).set('Host', host).set('Cookie', cookies);
    if (csrf) r = r.set('X-CSRF-Token', csrf);
    return r;
  };
  const ownerPost = (p: string, b: object = {}) => authed('post', p, ownerCookies, ownerCsrf).send(b);
  const login = async (e: string, pw: string) => {
    const res = await request(server()).post('/api/v1/auth/login').set('Host', host).send({ email: e, password: pw });
    return res.headers['set-cookie'] as unknown as string[];
  };

  /** A recent working day (the school's default weekly-off is SUNDAY). */
  const workingDay = (): string => {
    const d = new Date();
    while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const mark = (staffId: string, status: string, date = workingDay(), extra: object = {}) =>
    ownerPost('/api/v1/staff-attendance/bulk', { date, session: 'MORNING', records: [{ staffId, status }], ...extra });

  async function createStaff(email: string, campusId: string, joinedAt: string): Promise<string> {
    const res = await ownerPost('/api/v1/staff', {
      email, campusId, staffType: 'TEACHER', employeeCode: `EMP-${randomUUID().slice(0, 6)}`,
      designation: 'Teacher', joinedAt, fullName: `T ${email.split('@')[0]}`,
    });
    expect(res.status).toBe(201);
    return res.body.staffId;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const provisioning = app.get(ProvisioningService, { strict: false });
    const prov = await provisioning.provisionSchool({
      name: 'Staff Att School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password,
    });
    schoolId = prov.schoolId;
    campusA = prov.campusId;

    ownerCookies = await login(owner.email, owner.password);
    ownerCsrf = csrfOf(ownerCookies);
    ownerUserId = (await platform.user.findFirstOrThrow({ where: { schoolId, email: owner.email } })).id;

    await ownerPost('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    campusB = (await ownerPost('/api/v1/campuses', { name: 'Campus B' })).body.id;

    const longAgo = iso(new Date(Date.now() - 400 * 86400000));
    staffA = await createStaff('sa@sat.pk', campusA, longAgo);
    staffB = await createStaff('sb@sat.pk', campusB, longAgo);
    newJoiner = await createStaff('nj@sat.pk', campusA, iso(new Date()));

    await platform.user.create({
      data: {
        schoolId, campusId: campusA, email: admin.email, roles: ['CAMPUS_ADMIN'] as never, status: 'ACTIVE',
        passwordHash: await argon2.hash(admin.password, { type: argon2.argon2id }),
      },
    });
    adminCookies = await login(admin.email, admin.password);
    adminCsrf = csrfOf(adminCookies);
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  afterEach(async () => {
    await platform.staffAttendance.deleteMany({ where: { schoolId } });
    await platform.payrollRun.deleteMany({ where: { schoolId } });
  });

  it('records attendance with provenance — who marked it, and how', async () => {
    const res = await mark(staffA, 'PRESENT');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ succeeded: 1, failed: 0 });

    const row = await platform.staffAttendance.findFirstOrThrow({ where: { staffId: staffA } });
    // Provenance is the whole point: these rows move salaries, so "who says so" must survive.
    expect(row.source).toBe('ADMIN');
    expect(row.markedById).toBe(ownerUserId);
  });

  it('refuses a future date outright', async () => {
    const tomorrow = iso(new Date(Date.now() + 86400000));
    const res = await mark(staffA, 'PRESENT', tomorrow);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('a campus admin cannot mark another campus’s staff, and the good rows still land', async () => {
    // The live gap: this was accepted outright. Sent alongside a legitimate row, because the
    // partial-failure contract is the other half of the fix — one bad id must not reject a
    // register the office just typed.
    const res = await authed('post', '/api/v1/staff-attendance/bulk', adminCookies, adminCsrf).send({
      date: workingDay(), session: 'MORNING',
      records: [{ staffId: staffA, status: 'PRESENT' }, { staffId: staffB, status: 'PRESENT' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.succeeded).toBe(1);
    expect(res.body.failed).toBe(1);
    expect(res.body.errors[0]).toMatchObject({ index: 1, code: 'FORBIDDEN' });

    expect(await platform.staffAttendance.count({ where: { staffId: staffB } })).toBe(0);
    expect(await platform.staffAttendance.count({ where: { staffId: staffA } })).toBe(1);
  });

  it('refuses to mark someone on a date before they were employed', async () => {
    // Same rule the student register applies to enrolments: a backdated write must ask
    // "was this true THEN", not "is it true now".
    const lastWeek = iso(new Date(Date.now() - 7 * 86400000));
    const res = await mark(newJoiner, 'ABSENT', lastWeek);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ succeeded: 0, failed: 1 });
    expect(res.body.errors[0].message).toMatch(/Not employed/);
  });

  it('refuses a weekly-off day unless the override is passed', async () => {
    const sunday = new Date();
    while (sunday.getUTCDay() !== 0) sunday.setUTCDate(sunday.getUTCDate() - 1);

    const refused = await mark(staffA, 'PRESENT', iso(sunday));
    expect(refused.body).toMatchObject({ succeeded: 0, failed: 1 });
    expect(refused.body.errors[0].message).toMatch(/Holiday or weekly-off/);

    const forced = await mark(staffA, 'PRESENT', iso(sunday), { allowHolidayOverride: true });
    expect(forced.body).toMatchObject({ succeeded: 1, failed: 0 });
  });

  it('is idempotent on resubmit and updates on a real change', async () => {
    await mark(staffA, 'PRESENT');
    const again = await mark(staffA, 'PRESENT');
    expect(again.body).toMatchObject({ succeeded: 1, failed: 0 });
    expect(await platform.staffAttendance.count({ where: { staffId: staffA } })).toBe(1);

    await mark(staffA, 'ABSENT');
    const row = await platform.staffAttendance.findFirstOrThrow({ where: { staffId: staffA } });
    expect(row.status).toBe('ABSENT');
  });

  it('audits overriding a self-marked day, preserving what the staff member claimed', async () => {
    // Seeded directly: self check-in is S2. The override rule is what S1 owes it — an admin
    // replacing somebody's own claim about themselves changes their pay.
    const checkIn = new Date();
    await platform.staffAttendance.create({
      data: {
        schoolId, staffId: staffA, date: new Date(workingDay()), session: 'MORNING',
        status: 'PRESENT', source: 'SELF', checkIn,
      },
    });

    const res = await mark(staffA, 'ABSENT', workingDay(), { note: 'Not on site' });
    expect(res.body).toMatchObject({ succeeded: 1, failed: 0 });

    const audit = await platform.auditLog.findFirst({
      where: { schoolId, action: 'STAFF_ATTENDANCE_OVERRIDDEN' },
    });
    expect(audit).not.toBeNull();
    // The row now says ABSENT/ADMIN, so only the audit entry remembers the original claim.
    expect(audit!.oldValue).toMatchObject({ status: 'PRESENT', source: 'SELF' });
    expect(audit!.userId).toBe(ownerUserId);
  });

  it('does NOT audit an ordinary admin correction of an admin-marked day', async () => {
    // Auditing every keystroke buries the entries that matter — the same reason renames are
    // deliberately not audited.
    //
    // Measured as a DELTA, not an absolute count: `afterEach` clears attendance but audit rows
    // must outlive what they describe, so the override case above leaves one behind. Asserting
    // `toBe(0)` here passes or fails on test ORDER, which is not the property under test.
    const before = await platform.auditLog.count({ where: { schoolId, action: 'STAFF_ATTENDANCE_OVERRIDDEN' } });
    await mark(staffA, 'PRESENT');
    await mark(staffA, 'ABSENT');
    const after = await platform.auditLog.count({ where: { schoolId, action: 'STAFF_ATTENDANCE_OVERRIDDEN' } });
    expect(after).toBe(before);
  });

  it('freezes the month once its payroll run is approved', async () => {
    const day = workingDay();
    const d = new Date(day);
    await platform.payrollRun.create({
      data: {
        schoolId, campusId: campusA, month: d.getUTCMonth() + 1, year: d.getUTCFullYear(),
        status: 'APPROVED', createdById: ownerUserId,
      },
    });

    const res = await mark(staffA, 'ABSENT', day);
    // A payslip was computed FROM these rows. Letting them move afterwards leaves a paid
    // payslip disagreeing with its own register, and neither number can be trusted again.
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.message).toMatch(/reverse the payroll run/i);
    expect(await platform.staffAttendance.count({ where: { staffId: staffA } })).toBe(0);
  });
});
