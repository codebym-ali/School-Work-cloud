import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { admissionController } from './support/admission';
import { destroyTenant } from './support/tenant';
import { loginRequest } from './support/login';

/**
 * Student self-service portal (§28, matrix §23 STUDENT column). Read-only, self-scoped:
 * the logged-in STUDENT sees only their own record; non-students are denied.
 */
describe('Student portal (e2e, §28)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let ownerCookies: string[];
  let studentCookies: string[];
  let enrollmentId: string;
  let sectionId: string;
  let subjectId: string;
  let grNumber: string;
  let classId: string;
  let campusId: string;
  let yearId: string;
  let admit: (dto: object) => request.Test;
  let myStudentId: string;

  const sub = `sp-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@sp.pk', password: 'Owner!Secret12' };
  const studentLogin = { email: 'kid@sp.pk', password: 'Student!Secret12' };

  const server = () => app.getHttpServer();
  const login = async (email: string, password: string) => {
    const res = await loginRequest(server(), host, email, password);
    return res.headers['set-cookie'] as unknown as string[];
  };
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const ownerPost = (p: string, b: object) =>
    request(server()).post(p).set('Host', host).set('Cookie', ownerCookies).set('X-CSRF-Token', csrfOf(ownerCookies)).send(b);
  const get = (p: string, cookies: string[]) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const provisioning = app.get(ProvisioningService, { strict: false });
    const prov = await provisioning.provisionSchool({ name: 'SP School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;

    ownerCookies = await login(owner.email, owner.password);
    yearId = (await ownerPost('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true })).body.id;
    campusId = prov.campusId;
    const klass = await ownerPost('/api/v1/classes', { campusId: prov.campusId, name: 'Grade 1', order: 1 });
    classId = klass.body.id;
    const section = await ownerPost('/api/v1/sections', { classId: klass.body.id, name: 'A' });
    ({ admit } = await admissionController(app, platform, schoolId, host, prov.campusId));
    const student = await admit({
      fullName: 'Kid One', gender: 'MALE', dateOfBirth: '2015-05-10', campusId: prov.campusId, classId: klass.body.id, sectionId: section.body.id,
      guardian: { mode: 'CREATE', fullName: 'Papa', phone: '03007654321', relation: 'FATHER' },
    });
    grNumber = student.body.grNumber;
    myStudentId = student.body.studentId;
    enrollmentId = student.body.enrollmentId;
    sectionId = section.body.id;
    subjectId = (await ownerPost('/api/v1/subjects', { classId: klass.body.id, name: 'Maths' })).body.id;

    // Link a STUDENT login to that Student record (Student.userId).
    const user = await platform.user.create({
      data: { schoolId, email: studentLogin.email, passwordHash: await argon2.hash(studentLogin.password, { type: argon2.argon2id }), roles: ['STUDENT'], status: 'ACTIVE' },
    });
    await platform.student.update({ where: { id: student.body.studentId }, data: { userId: user.id } });
    studentCookies = await login(studentLogin.email, studentLogin.password);
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('overview returns the student\'s own profile + current enrollment', async () => {
    const res = await get('/api/v1/portal/overview', studentCookies);
    expect(res.status).toBe(200);
    expect(res.body.student).toMatchObject({ fullName: 'Kid One', grNumber });
    expect(res.body.enrollment).toMatchObject({ className: 'Grade 1', sectionName: 'A', year: '2026-27' });
    expect(res.body.guardians[0]).toMatchObject({ name: 'Papa', relation: 'FATHER', isPrimary: true });
  });

  it('attendance / results / fees are self-scoped and return arrays', async () => {
    for (const path of ['attendance', 'results', 'fees']) {
      const res = await get(`/api/v1/portal/${path}`, studentCookies);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    }
  });

  /**
   * Fees and receipts on the student's own page (B5).
   *
   * The security assertion is the second half: a STUDENT may fetch **their own** receipt and must
   * not be able to fetch anyone else's. The check lives in the service because it reads tenant
   * rows, so nothing but a test like this proves it actually fires.
   */
  it('shows the student their invoices WITH receipts, and refuses another child’s receipt', async () => {
    const sectionRes = await request(server()).get(`/api/v1/sections?classId=${classId}`).set('Host', host).set('Cookie', ownerCookies);
    const sid = sectionRes.body[0].id;

    const head = await ownerPost('/api/v1/fee-heads', { name: 'Tuition' });
    await ownerPost('/api/v1/fee-structures', {
      campusId, classId, feeHeadId: head.body.id, academicYearId: yearId, amount: 1000, frequency: 'MONTHLY',
    });

    // A second child, so "someone else's receipt" is a real row rather than a made-up id.
    const other = await admit({
      fullName: 'Kid Two', gender: 'FEMALE', dateOfBirth: '2015-06-11', campusId, classId, sectionId: sid,
      guardian: { mode: 'CREATE', fullName: 'Mama', phone: '03009998877', relation: 'MOTHER' },
    });

    await ownerPost('/api/v1/fees/invoice-batches', { classId, month: 9, year: 2026 });
    const invoicesOf = async (studentId: string) =>
      (await request(server()).get(`/api/v1/fees/invoices?studentId=${studentId}&month=9&year=2026`)
        .set('Host', host).set('Cookie', ownerCookies)).body.data;

    // The portal deliberately never returns a student id, so this comes from the fixture.
    const mine = (await invoicesOf(myStudentId))[0];
    const theirs = (await invoicesOf(other.body.studentId))[0];

    const payFor = async (invoiceId: string) =>
      request(server()).post(`/api/v1/fees/invoices/${invoiceId}/payments`)
        .set('Host', host).set('Cookie', ownerCookies).set('X-CSRF-Token', csrfOf(ownerCookies))
        .set('Idempotency-Key', randomUUID())
        .send({ amountPaid: 400, method: 'CASH' });

    const myPayment = await payFor(mine.id);
    const theirPayment = await payFor(theirs.id);
    expect(myPayment.status).toBe(201);
    expect(theirPayment.status).toBe(201);

    // The bill and what has been paid against it arrive together — "you owe X" without "and here
    // is receipt #N you already have" is the half-answer that starts a phone call.
    const fees = await get('/api/v1/portal/fees', studentCookies);
    const invoice = fees.body.find((f: { id: string }) => f.id === mine.id);
    expect(invoice.payments).toHaveLength(1);
    expect(invoice.payments[0]).toMatchObject({ receiptNo: myPayment.body.receiptNo, amount: 400, reversed: false });

    const ok = await get(`/api/v1/portal/fees/payments/${myPayment.body.paymentId}/receipt`, studentCookies);
    expect(ok.status).toBe(200);
    expect(ok.body.url).toBeTruthy();

    // Another child's receipt — 404, not 403: a student should not learn that the payment exists.
    const denied = await get(`/api/v1/portal/fees/payments/${theirPayment.body.paymentId}/receipt`, studentCookies);
    expect(denied.status).toBe(404);
  });

  /**
   * A student never applies for their own leave — decision, 2026-08-05.
   *
   * A parent tells the class teacher and the office writes it down. That is how a Pakistani
   * school actually works, and the child is not the one making the request. Guardians have no
   * logins, so there is no self-service leave path at all — by design, not omission.
   *
   * Asserted with a REAL student session because the permission matrix cannot: STUDENT is not one
   * of its seeded roles, so adding `'STUDENT'` to the `@Roles` list changes nothing there.
   *
   * **Proven non-vacuous the hard way**: adding `'STUDENT'` to the decorator and re-running left
   * all 461 tests green. The request gets past the guard and is then refused by the service's
   * guardian check — a student is nobody's guardian. So this test pins the BEHAVIOUR (a student
   * cannot file leave) rather than the decorator, which is the more durable of the two, and it
   * confirms the guardian check is load-bearing exactly as its own comment claims:
   *
   *   "it is the only thing standing between a non-admin caller and another student's record,
   *    so it must NOT be removed as 'parent code'."
   *
   * Neutering BOTH layers — `'STUDENT'` in the decorator and the guardian check removed — makes
   * this test fail with a 201: the student files a leave. So it guards the end-to-end property,
   * which is the thing worth guarding; either layer alone still holds the line.
   */
  it('cannot apply for leave, and cannot see anyone else\'s', async () => {
    const res = await request(server()).post('/api/v1/student-leaves')
      .set('Host', host).set('Cookie', studentCookies).set('X-CSRF-Token', csrfOf(studentCookies))
      .send({ studentId: myStudentId, fromDate: '2026-09-01', toDate: '2026-09-02', reason: 'Family trip' });
    expect(res.status).toBe(403);
    // Assert the CODE, not just the status: a CSRF failure is also 403, and a test that accepts
    // either would pass while proving nothing about roles. `FORBIDDEN` is the RolesGuard;
    // `CSRF_INVALID` would mean the request never reached it.
    expect(res.body.error.code).toBe('FORBIDDEN');

    // The LIST has no `@Roles` at all, so a student reaches it — and must come back empty. The
    // service scopes a non-admin, non-teacher caller to students they are a guardian OF, and a
    // student is nobody's guardian. That filter is the only thing between them and every leave
    // in the school, which is why it survived the parent portal's removal.
    const list = await get('/api/v1/student-leaves', studentCookies);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);

    // And the portal offers no route to it — there is nothing to click, either.
    expect((await get('/api/v1/portal/leaves', studentCookies)).status).toBe(404);
  });

  /** The student sees their OWN trend — never a rank or a class average. That is a product
   *  decision (comparison belongs on the staff side), so it is asserted, not left to drift. */
  it('reports class-test performance per subject, excluding absences from the average', async () => {
    // Two tests of different sizes plus one absence, so the response proves both rules at once.
    // Dates must be in the PAST — a test cannot be set for a day that hasn't happened.
    const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const thisMonth = daysAgo(1);
    const big = await ownerPost('/api/v1/class-tests', { sectionId, subjectId, name: 'Big test', totalMarks: 50, testDate: thisMonth });
    const small = await ownerPost('/api/v1/class-tests', { sectionId, subjectId, name: 'Quiz', totalMarks: 10, testDate: thisMonth });
    const missed = await ownerPost('/api/v1/class-tests', { sectionId, subjectId, name: 'Missed', totalMarks: 20, testDate: thisMonth });
    await ownerPost(`/api/v1/class-tests/${big.body.id}/scores`, { rows: [{ enrollmentId, marksObtained: 45 }] });
    await ownerPost(`/api/v1/class-tests/${small.body.id}/scores`, { rows: [{ enrollmentId, marksObtained: 2 }] });
    await ownerPost(`/api/v1/class-tests/${missed.body.id}/scores`, { rows: [{ enrollmentId, isAbsent: true }] });

    const res = await get('/api/v1/portal/performance', studentCookies);
    expect(res.status).toBe(200);

    // 47/60 = 78%. Averaging percentages would say 55%, and counting the absence as 0 would
    // say 47/80 = 59% — both wrong, and both would be visible to a child as a worse result.
    expect(res.body.overall.percent).toBe(78);
    expect(res.body.overall.testsTaken).toBe(2);
    expect(res.body.overall.testsMissed).toBe(1);

    const maths = res.body.subjects.find((x: { subjectName: string }) => x.subjectName === 'Maths');
    expect(maths.tests).toHaveLength(3);
    expect(maths.monthly[0].month).toBe(thisMonth.slice(0, 7));

    // No rank, no class average anywhere in the payload — a child must not be handed a position.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('rank');
    expect(raw).not.toContain('classAverage');
  });

  it('summarises attendance into counts rather than raw rows', async () => {
    const res = await get('/api/v1/portal/attendance/summary', studentCookies);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('counts.ABSENT');
    expect(res.body).toHaveProperty('percent');
    expect(Array.isArray(res.body.records)).toBe(true);
  });

  // Issue 3 (Tenant Dashboard QA, 2026-08-29): these structural reference lists shipped with no
  // @Roles, so a STUDENT portal session could enumerate the whole school's structure. They are now
  // STAFF_ROLES-gated. Asserted with a real student session (the permission matrix can't — STUDENT
  // is not a seeded matrix role), and on the CODE (FORBIDDEN = RolesGuard, not an incidental 404).
  it('cannot enumerate the school structure — class/section/subject/campus/year/exam lists are staff-only (Issue 3)', async () => {
    for (const path of [
      '/api/v1/classes',
      '/api/v1/sections',
      '/api/v1/subjects',
      '/api/v1/campuses',
      '/api/v1/academic-years',
      '/api/v1/exams',
      '/api/v1/terms',
      '/api/v1/grade-scales',
    ]) {
      const res = await get(path, studentCookies);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('denies a non-student (owner) the portal (403)', async () => {
    expect((await get('/api/v1/portal/overview', ownerCookies)).status).toBe(403);
  });
  /**
   * The student's own bell. ⚠️ **A separate endpoint from the staff `/notifications`, and these
   * cases exist to keep it that way**: a student is a different audience, not a staff member with
   * fewer rows. The last case is the one that matters — nothing about money reaches a child.
   */
  describe('notifications', () => {
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const kinds = async () => {
      const res = await get('/api/v1/portal/notifications', studentCookies);
      expect(res.status).toBe(200);
      return (res.body.items as Array<{ kind: string; text: string }>);
    };

    it('tells the student the school is shut tomorrow', async () => {
      const date = iso(new Date(Date.now() + 86_400_000));
      await ownerPost('/api/v1/holidays', { date, name: 'Eid ul Adha' }).expect(201);
      const closed = (await kinds()).find((i) => i.kind === 'SCHOOL_CLOSED');
      expect(closed).toBeDefined();
      expect(closed!.text).toContain('Eid ul Adha');
    });

    it('never mentions fees, however much is owed', async () => {
      // A child is not the person who pays. The portal shows them a fee page they can look at on
      // purpose; pushing a debt at them unprompted is a different thing entirely.
      const items = await kinds();
      for (const i of items) expect(i.text.toLowerCase()).not.toContain('fee');
      expect(items.map((i) => i.kind)).not.toContain('DEFAULTERS');
    });

    it('counts everything as new until they have looked, then stops', async () => {
      const before = await get('/api/v1/portal/notifications', studentCookies);
      expect(before.body.unread).toBe(before.body.items.length);
      expect(before.body.unread).toBeGreaterThan(0);
      await request(server()).post('/api/v1/portal/notifications/seen')
        .set('Host', host).set('Cookie', studentCookies).set('X-CSRF-Token', csrfOf(studentCookies))
        .send({}).expect(200);
      const after = await get('/api/v1/portal/notifications', studentCookies);
      expect(after.body.unread).toBe(0);
      expect(after.body.items.length).toBe(before.body.items.length);
    });

    it('is not reachable by staff', async () => {
      expect((await get('/api/v1/portal/notifications', ownerCookies)).status).toBe(403);
    });
  });
});
