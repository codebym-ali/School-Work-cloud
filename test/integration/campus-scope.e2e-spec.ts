import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { admissionController } from './support/admission';
import { SMS_QUEUE } from '../../apps/api/src/modules/comms/sms/sms.types';
import { destroyTenant } from './support/tenant';

/**
 * Campus scoping (blueprint §22.8, security playbook P1.7). One school with TWO campuses
 * (A, B). A CAMPUS_ADMIN and an ACCOUNTANT are bound to campus A. Non-OWNER_ADMIN roles
 * must be confined to their own campus deny-by-default: lists are force-scoped (a client
 * `?campusId=B` is ignored), and any cross-campus read/write is 403 — while OWNER_ADMIN
 * still sees the whole school (no regression).
 */
describe('Campus scoping (e2e, §22.8 / P1.7)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let campusA: string;
  let campusB: string;

  let ownerCookies: string[];
  let ownerCsrf: string;
  let adminCookies: string[]; // CAMPUS_ADMIN bound to campus A
  let acctCookies: string[]; // ACCOUNTANT bound to campus A
  let acctCsrf: string;

  let classA: string;
  let classB: string;
  let sectionA: string;
  let sectionB: string;
  let studentA: string;
  let studentB: string;
  let enrollmentA: string;
  let enrollmentB: string;
  let invoiceA: string;
  let invoiceB: string;

  const sub = `cs-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const email = 'owner@cs.pk';
  const password = 'Owner!Secret12';
  const adminEmail = 'campadmin@cs.pk';
  const acctEmail = 'acct@cs.pk';
  const staffPassword = 'Staff!Secret12';

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const authed = (method: 'get' | 'post' | 'patch' | 'delete', p: string, cookies: string[], csrf?: string) => {
    let r = request(server())[method](p).set('Host', host).set('Cookie', cookies);
    if (csrf) r = r.set('X-CSRF-Token', csrf);
    return r;
  };
  const ownerPost = (p: string, b: object = {}, headers: Record<string, string> = {}) => {
    let r = authed('post', p, ownerCookies, ownerCsrf);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(b);
  };
  const login = async (e: string, pw: string) => {
    const res = await request(server()).post('/api/v1/auth/login').set('Host', host).send({ email: e, password: pw });
    return res.headers['set-cookie'] as unknown as string[];
  };
  // A recent past, non-weekly-off (default off is SUNDAY) date for attendance marking.
  const safeDate = () => {
    const d = new Date();
    while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };

  async function createStaff(e: string, roles: string[], campusId: string): Promise<void> {
    await platform.user.create({
      data: {
        schoolId,
        campusId,
        email: e,
        roles: roles as never,
        status: 'ACTIVE',
        passwordHash: await argon2.hash(staffPassword, { type: argon2.argon2id }),
      },
    });
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
    const prov = await provisioning.provisionSchool({ name: 'CS School', subdomain: sub, ownerEmail: email, ownerPassword: password });
    schoolId = prov.schoolId;
    campusA = prov.campusId;

    ownerCookies = await login(email, password);
    ownerCsrf = csrfOf(ownerCookies);

    await ownerPost('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    campusB = (await ownerPost('/api/v1/campuses', { name: 'Campus B' })).body.id;

    // ONE admission officer per campus (§8/§23) — the seat is campus-bound, so this spec
    // seeds two. That is legal precisely because the campuses differ, and it is also what
    // makes the cross-campus assertions below meaningful: neither officer can reach the
    // other's campus, which a single school-wide controller used to be able to do.
    const { admit: admitA } = await admissionController(app, platform, schoolId, host, campusA);
    const { admit: admitB } = await admissionController(app, platform, schoolId, host, campusB);

    // Campus A: class + section + student (+ enrollment).
    classA = (await ownerPost('/api/v1/classes', { campusId: campusA, name: 'A-Grade', order: 1 })).body.id;
    sectionA = (await ownerPost('/api/v1/sections', { classId: classA, name: 'A' })).body.id;
    const sA = await admitA({
      fullName: 'Alice A', gender: 'FEMALE', dateOfBirth: '2016-01-10', campusId: campusA, classId: classA, sectionId: sectionA,
      guardian: { mode: 'CREATE', fullName: 'Guardian A', phone: '03001110001', relation: 'FATHER' },
    });
    studentA = sA.body.studentId;
    enrollmentA = sA.body.enrollmentId;

    // Campus B: class + section + student (+ enrollment).
    classB = (await ownerPost('/api/v1/classes', { campusId: campusB, name: 'B-Grade', order: 1 })).body.id;
    sectionB = (await ownerPost('/api/v1/sections', { classId: classB, name: 'B' })).body.id;
    const sB = await admitB({
      fullName: 'Bob B', gender: 'MALE', dateOfBirth: '2016-02-20', campusId: campusB, classId: classB, sectionId: sectionB,
      guardian: { mode: 'CREATE', fullName: 'Guardian B', phone: '03002220002', relation: 'FATHER' },
    });
    studentB = sB.body.studentId;
    enrollmentB = sB.body.enrollmentId;

    // Fee structures + invoice batches in BOTH campuses → invoiceA, invoiceB.
    const headA = await ownerPost('/api/v1/fee-heads', { name: 'Tuition A' });
    await ownerPost('/api/v1/fee-structures', { campusId: campusA, classId: classA, feeHeadId: headA.body.id, academicYearId: (await currentYear()).id, amount: 1000, frequency: 'MONTHLY' });
    const headB = await ownerPost('/api/v1/fee-heads', { name: 'Tuition B' });
    await ownerPost('/api/v1/fee-structures', { campusId: campusB, classId: classB, feeHeadId: headB.body.id, academicYearId: (await currentYear()).id, amount: 1000, frequency: 'MONTHLY' });
    await ownerPost('/api/v1/fees/invoice-batches', { classId: classA, month: 7, year: 2026 });
    await ownerPost('/api/v1/fees/invoice-batches', { classId: classB, month: 7, year: 2026 });
    invoiceA = (await authed('get', `/api/v1/fees/invoices?studentId=${studentA}`, ownerCookies)).body.data[0].id;
    invoiceB = (await authed('get', `/api/v1/fees/invoices?studentId=${studentB}`, ownerCookies)).body.data[0].id;

    // Campus-A-bound staff.
    await createStaff(adminEmail, ['CAMPUS_ADMIN'], campusA);
    await createStaff(acctEmail, ['ACCOUNTANT'], campusA);
    adminCookies = await login(adminEmail, staffPassword);
    acctCookies = await login(acctEmail, staffPassword);
    acctCsrf = csrfOf(acctCookies);
  });

  async function currentYear() {
    const res = await authed('get', '/api/v1/academic-years', ownerCookies);
    return (res.body as Array<{ id: string; isCurrent: boolean }>).find((y) => y.isCurrent)!;
  }

  afterAll(async () => {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  // ── Students ───────────────────────────────────────────────────────────────
  it('CAMPUS_ADMIN /students is force-scoped to campus A even with ?campusId=B', async () => {
    const all = await authed('get', '/api/v1/students', adminCookies);
    expect(all.status).toBe(200);
    const ids = (all.body.data as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain(studentA);
    expect(ids).not.toContain(studentB);

    // Attempting to widen to campus B is ignored (still only A).
    const spoof = await authed('get', `/api/v1/students?campusId=${campusB}`, adminCookies);
    const spoofIds = (spoof.body.data as Array<{ id: string }>).map((s) => s.id);
    expect(spoofIds).toEqual([studentA]);
  });

  it('CAMPUS_ADMIN can read a campus-A student but not a campus-B student (403)', async () => {
    expect((await authed('get', `/api/v1/students/${studentA}`, adminCookies)).status).toBe(200);
    const cross = await authed('get', `/api/v1/students/${studentB}`, adminCookies);
    expect(cross.status).toBe(403);
    expect(cross.body.error.code).toBe('FORBIDDEN');
  });

  it('CAMPUS_ADMIN report-cards: own campus student ok, another campus → 403', async () => {
    // A CAMPUS_ADMIN bypasses the guardian check (isAdminRole) but must still be campus-scoped,
    // exactly like the student detail read above — otherwise they can read any student's
    // academic records school-wide (P1.7 violation).
    expect((await authed('get', `/api/v1/students/${studentA}/report-cards`, adminCookies)).status).toBe(200);
    const cross = await authed('get', `/api/v1/students/${studentB}/report-cards`, adminCookies);
    expect(cross.status).toBe(403);
    expect(cross.body.error.code).toBe('FORBIDDEN');
  });

  // ── Attendance ───────────────────────────────────────────────────────────────
  it('CAMPUS_ADMIN attendance mark: campus A ok, campus B → 403', async () => {
    const date = safeDate();
    const ok = await authed('post', '/api/v1/attendance/bulk', adminCookies, csrfOf(adminCookies))
      .send({ sectionId: sectionA, date, session: 'MORNING', records: [{ enrollmentId: enrollmentA, status: 'PRESENT' }] });
    expect(ok.status).toBe(200);
    expect(ok.body.succeeded).toBe(1);

    const cross = await authed('post', '/api/v1/attendance/bulk', adminCookies, csrfOf(adminCookies))
      .send({ sectionId: sectionB, date, session: 'MORNING', records: [{ enrollmentId: enrollmentB, status: 'PRESENT' }] });
    expect(cross.status).toBe(403);
    expect(cross.body.error.code).toBe('FORBIDDEN');
  });

  // ── Fees ─────────────────────────────────────────────────────────────────────
  it('CAMPUS_ADMIN invoice list is scoped to A; a campus-B invoice read is 403', async () => {
    const list = await authed('get', '/api/v1/fees/invoices', adminCookies);
    const invIds = (list.body.data as Array<{ id: string }>).map((i) => i.id);
    expect(invIds).toContain(invoiceA);
    expect(invIds).not.toContain(invoiceB);

    const cross = await authed('get', `/api/v1/fees/invoices/${invoiceB}`, adminCookies);
    expect(cross.status).toBe(403);
    expect(cross.body.error.code).toBe('FORBIDDEN');
  });

  it('ACCOUNTANT bound to A cannot pay a campus-B invoice or bill class B (403), but can pay A', async () => {
    const idem = () => ({ 'Idempotency-Key': randomUUID() });

    const crossPay = await authed('post', `/api/v1/fees/invoices/${invoiceB}/payments`, acctCookies, acctCsrf)
      .set(idem()).send({ amountPaid: 100, method: 'CASH' });
    expect(crossPay.status).toBe(403);
    expect(crossPay.body.error.code).toBe('FORBIDDEN');

    const crossBatch = await authed('post', '/api/v1/fees/invoice-batches', acctCookies, acctCsrf)
      .send({ classId: classB, month: 8, year: 2026 });
    expect(crossBatch.status).toBe(403);

    const ownPay = await authed('post', `/api/v1/fees/invoices/${invoiceA}/payments`, acctCookies, acctCsrf)
      .set(idem()).send({ amountPaid: 100, method: 'CASH' });
    expect(ownPay.status).toBe(201);
  });

  // ── Admissions / Exams / Setup / HR (rolled-out surfaces) ───────────────────
  const adminCsrf = () => csrfOf(adminCookies);

  it('CAMPUS_ADMIN cannot create an inquiry in another campus', async () => {
    const res = await authed('post', '/api/v1/inquiries', adminCookies, adminCsrf())
      .send({ campusId: campusB, guardianName: 'G', guardianPhone: '03007770007', studentName: 'S', desiredClassId: classB });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('CAMPUS_ADMIN cannot create an exam for another campus class', async () => {
    const res = await authed('post', '/api/v1/exams', adminCookies, adminCsrf())
      .send({ termId: randomUUID(), classId: classB, name: 'X', examType: 'MID_TERM', weightagePercent: 50, examDate: '2026-07-08' });
    expect(res.status).toBe(403);
  });

  it('CAMPUS_ADMIN /classes is scoped to A; class/section create in B → 403', async () => {
    const list = await authed('get', '/api/v1/classes', adminCookies);
    const ids = (list.body as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain(classA);
    expect(ids).not.toContain(classB);

    expect((await authed('post', '/api/v1/classes', adminCookies, adminCsrf()).send({ campusId: campusB, name: 'Nope', order: 9 })).status).toBe(403);
    expect((await authed('post', '/api/v1/sections', adminCookies, adminCsrf()).send({ classId: classB, name: 'Z' })).status).toBe(403);
  });

  it('CAMPUS_ADMIN cannot create staff in another campus', async () => {
    const res = await authed('post', '/api/v1/staff', adminCookies, adminCsrf()).send({
      email: `t-${randomUUID().slice(0, 8)}@cs.pk`, staffType: 'TEACHER',
      employeeCode: `E-${randomUUID().slice(0, 6)}`, designation: 'Teacher', joinedAt: '2026-01-01', campusId: campusB,
    });
    expect(res.status).toBe(403);
  });

  // ── OWNER_ADMIN (no regression) ──────────────────────────────────────────────
  it('OWNER_ADMIN still sees both campuses', async () => {
    const students = await authed('get', '/api/v1/students', ownerCookies);
    const ids = (students.body.data as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining([studentA, studentB]));

    expect((await authed('get', `/api/v1/students/${studentB}`, ownerCookies)).status).toBe(200);

    const invoices = await authed('get', '/api/v1/fees/invoices', ownerCookies);
    const invIds = (invoices.body.data as Array<{ id: string }>).map((i) => i.id);
    expect(invIds).toEqual(expect.arrayContaining([invoiceA, invoiceB]));
  });

  // ── Dashboard role-shaping (§28, P1.7) ───────────────────────────────────────
  it('dashboard is campus-scoped: OWNER sees both students, CAMPUS_ADMIN only campus A', async () => {
    const owner = await authed('get', '/api/v1/dashboard', ownerCookies);
    expect(owner.body.enrollmentCount).toBe(2); // one student per campus
    expect(owner.body.visible).toEqual(expect.arrayContaining(['enrollmentCount', 'todayAttendancePercent', 'pendingLeaves', 'failedSmsCount']));

    const admin = await authed('get', '/api/v1/dashboard', adminCookies);
    expect(admin.body.enrollmentCount).toBe(1); // campus A only
  });

  // ── Renaming & removal guards ──────────────────────────────────────────────
  // Classes/sections/subjects were create-and-read only, so a typo was permanent. Deletes
  // must refuse while something real depends on the row, and say what.
  it('renames a class, and refuses to delete one that still has sections', async () => {
    const renamed = await authed('patch', `/api/v1/classes/${classA}`, ownerCookies, ownerCsrf).send({ name: 'Grade 9 (renamed)' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Grade 9 (renamed)');

    const blocked = await authed('delete', `/api/v1/classes/${classA}`, ownerCookies, ownerCsrf);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('section');
  });

  it('refuses to delete a section that still has an enrolled student', async () => {
    const res = await authed('delete', `/api/v1/sections/${sectionA}`, ownerCookies, ownerCsrf);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('enrolment');
  });

  it('renames a subject, and deletes an unused one', async () => {
    const created = await ownerPost('/api/v1/subjects', { classId: classA, name: 'Temp Subject' });
    expect(created.status).toBe(201);

    const renamed = await authed('patch', `/api/v1/subjects/${created.body.id}`, ownerCookies, ownerCsrf).send({ name: 'Renamed Subject' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Renamed Subject');

    const removed = await authed('delete', `/api/v1/subjects/${created.body.id}`, ownerCookies, ownerCsrf);
    expect(removed.status).toBe(204);
  });

  it('deletes an empty section, and then the now-empty class', async () => {
    const cls = await ownerPost('/api/v1/classes', { campusId: campusA, name: 'Disposable', order: 99 });
    const sec = await ownerPost('/api/v1/sections', { classId: cls.body.id, name: 'Z' });

    expect((await authed('delete', `/api/v1/sections/${sec.body.id}`, ownerCookies, ownerCsrf)).status).toBe(204);
    expect((await authed('delete', `/api/v1/classes/${cls.body.id}`, ownerCookies, ownerCsrf)).status).toBe(204);
  });

  // Destructive actions must leave a trail. audit_logs has no FK to the entity (so the row
  // survives the delete), which means oldValue has to carry enough identity to say WHAT went.
  it('records an audit row naming what was deleted (class, section, subject)', async () => {
    const cls = await ownerPost('/api/v1/classes', { campusId: campusA, name: 'Audited Class', order: 98 });
    const sec = await ownerPost('/api/v1/sections', { classId: cls.body.id, name: 'Q' });
    const sub = await ownerPost('/api/v1/subjects', { classId: cls.body.id, name: 'Audited Subject' });

    await authed('delete', `/api/v1/subjects/${sub.body.id}`, ownerCookies, ownerCsrf);
    await authed('delete', `/api/v1/sections/${sec.body.id}`, ownerCookies, ownerCsrf);
    await authed('delete', `/api/v1/classes/${cls.body.id}`, ownerCookies, ownerCsrf);

    // Scope to the ids created HERE — earlier tests in this spec also delete structure now,
    // so filtering by action alone would pick their rows up too.
    const rows = await platform.auditLog.findMany({
      where: { schoolId, entityId: { in: [cls.body.id, sec.body.id, sub.body.id] } },
    });
    expect(rows.map((r) => r.action).sort()).toEqual(['CLASS_DELETED', 'SECTION_DELETED', 'SUBJECT_DELETED']);

    // The names must survive — the entityIds now dangle.
    const byAction = new Map(rows.map((r) => [r.action, r.oldValue as Record<string, unknown>]));
    expect(byAction.get('CLASS_DELETED')?.name).toBe('Audited Class');
    expect(byAction.get('SECTION_DELETED')?.name).toBe('Q');
    expect(byAction.get('SUBJECT_DELETED')?.name).toBe('Audited Subject');
    // Every row names the actor.
    expect(rows.every((r) => Boolean(r.userId))).toBe(true);
  });

  it('dashboard is role-shaped: an ACCOUNTANT sees financial metrics only', async () => {
    const acct = await authed('get', '/api/v1/dashboard', acctCookies);
    expect(acct.body.visible).toEqual(['enrollmentCount', 'monthCollections', 'defaulterCount']);
    // Ops metrics are neither computed nor shown for an accountant.
    expect(acct.body.todayAttendancePercent).toBeNull();
    expect(acct.body.pendingLeaves).toBeNull();
    expect(acct.body.failedSmsCount).toBeNull();
    // Financial metrics are campus-scoped to A (their one student).
    expect(acct.body.enrollmentCount).toBe(1);
  });
});
