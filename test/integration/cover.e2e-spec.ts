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
import { admissionController } from './support/admission';

/**
 * Cover (Cover Plan, C0) — the substitute can mark the register.
 *
 * The whole feature is one sentence of behaviour: a teacher who neither teaches nor covers a
 * section is refused, and a teacher who **covers** it is not. So the load-bearing case is the
 * pair — refused before, allowed after — because either half alone proves nothing.
 *
 * The rest guards the fact that cover is a **permission grant**: narrow to one section and one
 * date, refused into a settled payroll month, and revocable.
 */
describe('Cover (e2e) — who may mark when the teacher is away', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let campusId: string;
  let ownerCookies: string[];
  let ownerCsrf: string;
  let subCookies: string[];   // the substitute: teaches NOTHING
  let subCsrf: string;
  let awayCookies: string[];  // the teacher whose classes these are
  let classId: string;
  let sectionA: string;
  let sectionB: string;
  let subStaffId: string;
  let absentStaffId: string;
  let enrolmentA: string;

  const sub = `cv-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@cv.pk', password: 'Owner!Secret12' };
  const substitute = { email: 'fatima@cv.pk', password: 'Cover!Secret12' };
  const away = { email: 'nadia@cv.pk', password: 'Away!Secret12' };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object = {}) =>
    request(server()).post(p).set('Host', host).set('Cookie', ownerCookies).set('X-CSRF-Token', ownerCsrf).send(b);
  const del = (p: string) =>
    request(server()).delete(p).set('Host', host).set('Cookie', ownerCookies).set('X-CSRF-Token', ownerCsrf);
  const get = (p: string, c = ownerCookies) => request(server()).get(p).set('Host', host).set('Cookie', c);
  const login = async (e: string, pw: string) => {
    const res = await request(server()).post('/api/v1/auth/login').set('Host', host).send({ email: e, password: pw });
    return res.headers['set-cookie'] as unknown as string[];
  };

  /** The substitute tries to mark section A. This is the assertion the feature exists for. */
  const subMarks = (sectionId: string, date: string) =>
    request(server()).post('/api/v1/attendance/bulk').set('Host', host).set('Cookie', subCookies).set('X-CSRF-Token', subCsrf)
      .send({ sectionId, date, session: 'MORNING', records: [{ enrollmentId: enrolmentA, status: 'PRESENT' }] });

  /**
   * Two recent days, computed rather than fixed.
   *
   * Attendance cannot be marked in the future, and a TEACHER may only backfill
   * `attendanceBackfillDays` (default 7) into the past — so hardcoded dates a month back are
   * refused with 422 before authorization is ever consulted, and every case here would have been
   * measuring the wrong thing. `weeklyOffDays: []` in the fixture makes any day workable.
   */
  const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
  /**
   * TODAY, not a past day — and that took two attempts to get right.
   *
   * A fixed date a month back is refused with 422 (a teacher may only backfill
   * `attendanceBackfillDays`, default 7). *Yesterday* gets past authorization but saves nothing:
   * the enrolment must have been active **on the date being marked**, and the student is admitted
   * during this fixture, so yesterday they did not yet exist. Today satisfies both.
   */
  const DAY = iso(0);
  /** Yesterday — used only where the assertion is a 403, which authorization raises before any
   *  per-record rule is consulted. */
  const OTHER_DAY = iso(1);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const prov = await app.get(ProvisioningService, { strict: false }).provisionSchool({
      name: 'Cv School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password,
    });
    schoolId = prov.schoolId;
    campusId = prov.campusId;

    ownerCookies = await login(owner.email, owner.password);
    ownerCsrf = csrfOf(ownerCookies);
    const yearId = (await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true })).body.id;
    // Every day is a working day, so the cases do not depend on which day the suite runs.
    await request(server()).patch('/api/v1/school-settings').set('Host', host)
      .set('Cookie', ownerCookies).set('X-CSRF-Token', ownerCsrf).send({ weeklyOffDays: [] });

    classId = (await post('/api/v1/classes', { campusId, name: 'Grade 9', order: 9 })).body.id;
    sectionA = (await post('/api/v1/sections', { classId, name: 'A' })).body.id;
    sectionB = (await post('/api/v1/sections', { classId, name: 'B' })).body.id;

    const mkStaff = async (email: string, code: string, password?: string) => {
      const res = await post('/api/v1/staff', {
        email, campusId, staffType: 'TEACHER', employeeCode: code,
        designation: 'Teacher', joinedAt: '2026-04-01', fullName: `T ${code}`,
      });
      expect(res.status).toBe(201);
      const id = res.body.staffId as string;
      if (password) {
        const p = await platform.staffProfile.findFirstOrThrow({ where: { id }, select: { userId: true } });
        await platform.user.update({
          where: { id: p.userId! },
          data: { passwordHash: await argon2.hash(password, { type: argon2.argon2id }), roles: ['TEACHER'] as never, status: 'ACTIVE' },
        });
      }
      return id;
    };
    // ⚠️ The substitute is given NO teacher assignment anywhere. That is the point: everything
    // she can do here, she can do *only* because of cover.
    subStaffId = await mkStaff(substitute.email, 'EMP-SUB', substitute.password);
    // Nadia gets a login too: C2 is about what each of them is TOLD, and the absent teacher's
    // half — "who took my class", and no longer being chased for it — can only be asserted from
    // her own session.
    absentStaffId = await mkStaff(away.email, 'EMP-001', away.password);
    subCookies = await login(substitute.email, substitute.password);
    subCsrf = csrfOf(subCookies);
    awayCookies = await login(away.email, away.password);

    // Nadia teaches BOTH sections, and 9-A twice — two subjects to one class. C1's "away" list has
    // to answer with classes, not with assignment rows, or the office sees 9-A listed twice and
    // arranges the same cover two ways.
    const maths = (await post('/api/v1/subjects', { classId, name: 'Mathematics' })).body.id;
    const science = (await post('/api/v1/subjects', { classId, name: 'Science' })).body.id;
    for (const [sectionId, subjectId] of [[sectionA, maths], [sectionA, science], [sectionB, maths]]) {
      expect((await post('/api/v1/teacher-assignments', { staffId: absentStaffId, academicYearId: yearId, sectionId, subjectId })).status).toBe(201);
    }

    const { admit } = await admissionController(app, platform, schoolId, host, campusId);
    const student = await admit({
      fullName: 'Ayesha Malik', gender: 'FEMALE', dateOfBirth: '2011-05-10',
      campusId, classId, sectionId: sectionA,
      guardian: { mode: 'CREATE', fullName: 'Asif Malik', phone: '03001234567', relation: 'FATHER' },
    });
    enrolmentA = student.body.enrollmentId;

    // Section B needs a child too. `unmarkedToday` and the register reminder both skip a section
    // with nobody in it — correctly, since an empty section cannot be behind on anything — so an
    // empty B would make every assertion about B pass without measuring it.
    await admit({
      fullName: 'Bilal Raza', gender: 'MALE', dateOfBirth: '2011-07-02',
      campusId, classId, sectionId: sectionB,
      guardian: { mode: 'CREATE', fullName: 'Raza Khan', phone: '03007654321', relation: 'FATHER' },
    });
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  afterEach(async () => {
    await platform.coverAssignment.deleteMany({ where: { schoolId } });
    await platform.attendanceRecord.deleteMany({ where: { schoolId } });
  });

  // ── the pair the whole feature is ─────────────────────────────────────────
  it('refuses a teacher who neither teaches nor covers the section', async () => {
    const res = await subMarks(sectionA, DAY);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('not assigned to this section');
  });

  it('lets that same teacher mark it once cover is recorded', async () => {
    const cover = await post('/api/v1/cover', {
      sectionId: sectionA, date: DAY, coveringStaffId: subStaffId, absentStaffId, reason: 'Nadia away',
    });
    expect(cover.status).toBe(201);

    // Same request, same person, same section — the only thing that changed is the grant.
    // 200, not 201: `/attendance/bulk` carries the partial-failure shape (§25.3) and is
    // explicitly @HttpCode(200), because it can succeed for some rows and fail for others.
    const res = await subMarks(sectionA, DAY);
    expect(res.status).toBe(200);
    expect(res.body.succeeded).toBe(1);
  });

  // ── the grant is narrow ───────────────────────────────────────────────────
  it('does not let the cover mark a DIFFERENT section', async () => {
    await post('/api/v1/cover', { sectionId: sectionA, date: DAY, coveringStaffId: subStaffId });
    // Section B has a child of its own, so this 403 is authorization refusing on the SECTION —
    // the enrolment sent belongs to A, and `assertCanMark` runs before any record is looked at.
    const res = await request(server()).post('/api/v1/attendance/bulk').set('Host', host)
      .set('Cookie', subCookies).set('X-CSRF-Token', subCsrf)
      .send({ sectionId: sectionB, date: DAY, session: 'MORNING', records: [{ enrollmentId: enrolmentA, status: 'PRESENT' }] });
    expect(res.status).toBe(403);
  });

  it('does not let the cover mark a DIFFERENT date', async () => {
    await post('/api/v1/cover', { sectionId: sectionA, date: DAY, coveringStaffId: subStaffId });
    // Cover was for Monday; this is Tuesday. Backfilling yesterday is only for whoever covered it.
    expect((await subMarks(sectionA, OTHER_DAY)).status).toBe(403);
  });

  it('takes the right back when cover is removed', async () => {
    const cover = await post('/api/v1/cover', { sectionId: sectionA, date: DAY, coveringStaffId: subStaffId });
    expect((await subMarks(sectionA, DAY)).status).toBe(200);

    expect((await del(`/api/v1/cover/${cover.body.id}`)).status).toBe(200);
    // A grant that could not be revoked would be a role, not cover.
    expect((await subMarks(sectionA, DAY)).status).toBe(403);
  });

  it('lists the day it was asked for, with the names the office reads', async () => {
    await post('/api/v1/cover', {
      sectionId: sectionA, date: DAY, coveringStaffId: subStaffId, absentStaffId, reason: 'Fever',
    });

    const today = await get(`/api/v1/cover?date=${DAY}`);
    expect(today.status).toBe(200);
    expect(today.body.cover).toHaveLength(1);
    // Names, not ids: the office screen shows this row verbatim, and a list of UUIDs would send
    // them back to the class and staff screens to work out what they are looking at.
    expect(today.body.cover[0]).toMatchObject({
      section: { name: 'A', class: { name: 'Grade 9' } },
      coveringStaff: { employeeCode: 'EMP-SUB' },
      absentStaff: { employeeCode: 'EMP-001' },
      reason: 'Fever',
    });

    // The date is the whole query. A list that ignored it would show yesterday's cover as today's
    // and quietly tell the office that a class is already handled.
    expect((await get(`/api/v1/cover?date=${OTHER_DAY}`)).body.cover).toEqual([]);
  });

  // ── it is a permission grant, so it is guarded and recorded ───────────────
  it('refuses two people covering the same class on the same day', async () => {
    await post('/api/v1/cover', { sectionId: sectionA, date: DAY, coveringStaffId: subStaffId });
    const second = await post('/api/v1/cover', { sectionId: sectionA, date: DAY, coveringStaffId: absentStaffId });
    // A plain UNIQUE(section, date, period_no) would NOT catch this — period_no is null on both,
    // and Postgres treats NULLs as distinct. The partial index is what makes this a 409.
    expect(second.status).toBe(409);
    expect(second.body.error.message).toContain('already covering');
  });

  it('refuses cover into a month whose payroll is already approved', async () => {
    const d = new Date(DAY);
    const run = await post('/api/v1/payroll-runs', { campusId, month: d.getUTCMonth() + 1, year: d.getUTCFullYear() });
    await post(`/api/v1/payroll-runs/${run.body.runId}/approve`);

    const res = await post('/api/v1/cover', { sectionId: sectionA, date: DAY, coveringStaffId: subStaffId });
    // Cover grants the right to CHANGE attendance, so granting it into a settled month is the same
    // hole as editing the register directly — a paid payslip must keep agreeing with its register.
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('already approved');

    await platform.payslip.deleteMany({ where: { schoolId } });
    await platform.payrollRun.deleteMany({ where: { schoolId } });
  });

  it('records who granted it and who it was for', async () => {
    await post('/api/v1/cover', {
      sectionId: sectionA, date: DAY, coveringStaffId: subStaffId, absentStaffId, reason: 'Fever',
    });
    const log = await platform.auditLog.findFirstOrThrow({
      where: { schoolId, action: 'COVER_ASSIGNED' }, orderBy: { createdAt: 'desc' },
    });
    // Names, not only ids: audit_logs has no FK to the entity by design, so the row has to say
    // what it was about after the cover itself is gone.
    expect(log.newValue).toMatchObject({ section: 'Grade 9-A', covering: 'T EMP-SUB', absent: 'T EMP-001', reason: 'Fever' });
  });

  // ── C1: start from who is away, and from a whole absence ──────────────────
  describe('who is away (C1)', () => {
    const markStaff = (status: string, date = DAY) =>
      post('/api/v1/staff-attendance/bulk', {
        date, session: 'MORNING', allowHolidayOverride: true,
        records: [{ staffId: absentStaffId, status }],
      });

    afterEach(async () => {
      await platform.staffAttendance.deleteMany({ where: { schoolId } });
      await platform.staffLeave.deleteMany({ where: { schoolId } });
    });

    it('names the away teacher and the classes that are hers', async () => {
      expect((await markStaff('ABSENT')).status).toBe(200);

      const res = await get(`/api/v1/cover/away?date=${DAY}`);
      expect(res.status).toBe(200);
      expect(res.body.staffRegisterMarked).toBe(true);
      expect(res.body.away).toHaveLength(1);
      expect(res.body.away[0]).toMatchObject({ staffId: absentStaffId, reason: 'Marked absent' });
      // Both her sections, each once — she teaches two subjects to 9-A and that is still one class
      // to arrange cover for. Deduping is the difference between a worklist and a list of rows.
      expect(res.body.away[0].sections.map((s: { sectionName: string }) => s.sectionName)).toEqual(['A', 'B']);
      expect(res.body.away[0].sections[0].coveredBy).toBeNull();
    });

    it('says who is already covered, so the office knows what is left', async () => {
      await markStaff('ABSENT');
      await post('/api/v1/cover', { sectionId: sectionA, date: DAY, coveringStaffId: subStaffId });

      const row = (await get(`/api/v1/cover/away?date=${DAY}`)).body.away[0];
      // Without this the list is a list of her classes, not of the ones still needing somebody —
      // and the office arranges the same cover twice, which the clash check then refuses.
      expect(row.sections.find((s: { sectionName: string }) => s.sectionName === 'A').coveredBy).toBe('T EMP-SUB');
      expect(row.sections.find((s: { sectionName: string }) => s.sectionName === 'B').coveredBy).toBeNull();
    });

    it('finds approved leave even when the staff register was never marked', async () => {
      const leave = await post('/api/v1/staff-leaves', {
        staffId: absentStaffId, leaveType: 'SICK', fromDate: DAY, toDate: DAY, reason: 'Flu',
      });
      expect(leave.status).toBe(201);
      await post(`/api/v1/staff-leaves/${leave.body.id}/approve`);
      await platform.staffAttendance.deleteMany({ where: { schoolId } }); // approving settles the register (L4)

      const res = await get(`/api/v1/cover/away?date=${DAY}`);
      // Leave is approved days ahead and the register is marked at 08:00 — a list that read only
      // the register would be empty every time the office looked before school started.
      expect(res.body.staffRegisterMarked).toBe(false);
      expect(res.body.away).toHaveLength(1);
      expect(res.body.away[0].reason).toContain('approved sick leave');
    });

    it('leaves out whoever actually turned up', async () => {
      await markStaff('PRESENT');
      expect((await get(`/api/v1/cover/away?date=${DAY}`)).body.away).toEqual([]);
      // And the day is not confused with another: she is away today, not tomorrow.
      await markStaff('ABSENT');
      expect((await get(`/api/v1/cover/away?date=${OTHER_DAY}`)).body.away).toEqual([]);
      expect((await get(`/api/v1/cover/away?date=${DAY}`)).body.away).toHaveLength(1);
    });

    it('lets the register overrule an approved leave that was worked through', async () => {
      const leave = await post('/api/v1/staff-leaves', {
        staffId: absentStaffId, leaveType: 'CASUAL', fromDate: DAY, toDate: DAY, reason: 'Errand',
      });
      await post(`/api/v1/staff-leaves/${leave.body.id}/approve`);
      await markStaff('PRESENT');

      // She came in anyway. Listing her as away would send the office looking for cover for
      // classes she is standing in front of.
      expect((await get(`/api/v1/cover/away?date=${DAY}`)).body.away).toEqual([]);
    });
  });

  describe('a whole absence at once (C1)', () => {
    const range = (body: object) => post('/api/v1/cover/range', body);

    it('covers every working day in the range', async () => {
      const res = await range({
        sectionId: sectionA, fromDate: iso(2), toDate: DAY, coveringStaffId: subStaffId, reason: 'Sick until Monday',
      });
      expect(res.status).toBe(200);
      expect(res.body.created).toHaveLength(3);
      expect(res.body.created.map((c: { date: string }) => c.date.slice(0, 10))).toEqual([iso(2), iso(1), DAY]);
      // The grant is real on every one of them, not just the first.
      expect((await subMarks(sectionA, iso(1))).status).toBe(200);
    });

    it('skips a closure instead of refusing the whole range', async () => {
      await post('/api/v1/holidays', { date: iso(1), name: 'Independence Day', campusId });
      const res = await range({ sectionId: sectionA, fromDate: iso(2), toDate: DAY, coveringStaffId: subStaffId });

      expect(res.body.created).toHaveLength(2);
      // Refusing outright would send the office back to entering the other two days by hand; a
      // cover on a day the school is shut would put her name against a day nobody came in.
      expect(res.body.skipped).toEqual([{ date: iso(1), reason: 'School is closed that day' }]);
      await platform.holiday.deleteMany({ where: { schoolId } });
    });

    it('skips a day someone else already has, and says who', async () => {
      await post('/api/v1/cover', { sectionId: sectionA, date: iso(1), coveringStaffId: absentStaffId });
      const res = await range({ sectionId: sectionA, fromDate: iso(2), toDate: DAY, coveringStaffId: subStaffId });

      expect(res.body.created).toHaveLength(2);
      expect(res.body.skipped[0].reason).toContain('T EMP-001 is already covering Grade 9-A');
      // The other two days still happened — a partial answer the office can read and act on.
      expect((await subMarks(sectionA, DAY)).status).toBe(200);
    });

    it('refuses a range that is backwards or absurdly long', async () => {
      expect((await range({ sectionId: sectionA, fromDate: DAY, toDate: iso(2), coveringStaffId: subStaffId })).status).toBe(422);
      const long = await range({ sectionId: sectionA, fromDate: iso(60), toDate: DAY, coveringStaffId: subStaffId });
      // Held down by mistake, a date picker will happily produce a year. That is a reassignment,
      // and it would hand one teacher standing access to another class's register.
      expect(long.status).toBe(422);
      expect(long.body.error.message).toContain('31 days');
    });
  });

  // ── C3: who could take it, best first ─────────────────────────────────────
  describe('who could take it (C3)', () => {
    const suggest = (extra = '') => get(`/api/v1/cover/suggestions?sectionId=${sectionA}&date=${DAY}${extra}`);
    const byCode = (body: { suggestions: { employeeCode: string; status: string; note: string }[] }, code: string) =>
      body.suggestions.find((s) => s.employeeCode === code);

    afterEach(async () => {
      await platform.staffAttendance.deleteMany({ where: { schoolId } });
      await platform.staffLeave.deleteMany({ where: { schoolId } });
      await platform.timetableSlot.deleteMany({ where: { schoolId } });
    });

    it('will not claim anybody is FREE when there is no timetable to check', async () => {
      const res = await suggest('&periodNo=2');
      expect(res.status).toBe(200);
      // ⚠️ The load-bearing case. `timetable_slots` is empty in every school today, and a
      // suggestion that says "free" on no evidence is worse than one that admits what it knows —
      // the office would trust it and double-book somebody.
      expect(res.body.timetableKnown).toBe(false);
      expect(res.body.suggestions.map((s: { status: string }) => s.status)).not.toContain('FREE');
      expect(byCode(res.body, 'EMP-SUB')).toMatchObject({ status: 'IN_SCHOOL', note: 'In school today' });
    });

    it('says FREE only once the timetable proves it, and BUSY when it disproves it', async () => {
      // A real period for Nadia this weekday. Now the table can answer for period 2.
      const subjectId = (await get(`/api/v1/subjects?classId=${classId}`)).body[0].id;
      const dow = new Date(DAY).getUTCDay() === 0 ? 7 : new Date(DAY).getUTCDay();
      const slot = await post('/api/v1/timetable/slots', { sectionId: sectionB, dayOfWeek: dow, periodNo: 2, subjectId, staffId: absentStaffId });
      expect(slot.status).toBe(201);

      const res = await suggest('&periodNo=2');
      expect(res.body.timetableKnown).toBe(true);
      // Fatima has no periods at all, so the table positively says she is free.
      expect(byCode(res.body, 'EMP-SUB')).toMatchObject({ status: 'FREE' });
      // Nadia is teaching 9-B then, and the note says which class — "busy" alone sends the office
      // looking for the reason.
      expect(byCode(res.body, 'EMP-001')).toMatchObject({ status: 'BUSY' });
      expect(byCode(res.body, 'EMP-001')!.note).toContain('Teaching Grade 9-B that period');
    });

    it('puts the away and the busy last, but never hides them', async () => {
      await post('/api/v1/staff-attendance/bulk', {
        date: DAY, session: 'MORNING', allowHolidayOverride: true,
        records: [{ staffId: absentStaffId, status: 'ABSENT' }],
      });
      const res = await suggest();

      expect(byCode(res.body, 'EMP-001')).toMatchObject({ status: 'AWAY', note: 'Marked absent' });
      // Nobody is removed. An administrator may know something the register does not — that
      // somebody came in late and unmarked — so the list orders and explains rather than forbids.
      expect(res.body.suggestions).toHaveLength(2);
      expect(res.body.suggestions[0].employeeCode).toBe('EMP-SUB');
    });

    it('offers somebody who worked through their approved leave', async () => {
      const leave = await post('/api/v1/staff-leaves', {
        staffId: subStaffId, leaveType: 'CASUAL', fromDate: DAY, toDate: DAY, reason: 'Errand',
      });
      await post(`/api/v1/staff-leaves/${leave.body.id}/approve`);
      expect(byCode((await suggest()).body, 'EMP-SUB')).toMatchObject({ status: 'AWAY' });

      await post('/api/v1/staff-attendance/bulk', {
        date: DAY, session: 'MORNING', allowHolidayOverride: true,
        records: [{ staffId: subStaffId, status: 'PRESENT' }],
      });
      // ⚠️ This case exists because a probe found nothing to break. C1's `away()` and C3's
      // suggestions each had their own copy of this precedence and only one was tested, so the
      // untested copy could have been inverted silently. They are now one function — and this
      // asserts the C3 side of it, since a shared helper with one caller under test is the same
      // hole wearing a better name.
      expect(byCode((await suggest()).body, 'EMP-SUB')).toMatchObject({ status: 'IN_SCHOOL' });
    });

    it('marks somebody already covering another class as busy, but not for this one', async () => {
      await post('/api/v1/cover', { sectionId: sectionB, date: DAY, coveringStaffId: subStaffId });
      expect(byCode((await suggest()).body, 'EMP-SUB')!.note).toContain('Already covering Grade 9-B');

      await platform.coverAssignment.deleteMany({ where: { schoolId } });
      await post('/api/v1/cover', { sectionId: sectionA, date: DAY, coveringStaffId: subStaffId });
      // Being asked to cover the SAME class twice is not a clash — `create` refuses the duplicate
      // on its own, and calling it "busy" here would read as a different problem entirely.
      expect(byCode((await suggest()).body, 'EMP-SUB')).toMatchObject({ status: 'IN_SCHOOL' });
    });
  });

  // ── C2: both people are told, and responsibility moves with the cover ─────
  describe('the people it happens to (C2)', () => {
    const bell = (cookies: string[]) => get('/api/v1/notifications', cookies);
    const kinds = (body: { items: { kind: string; text: string }[] }, kind: string) =>
      body.items.filter((i) => i.kind === kind);

    it('tells the substitute they have a class, and the teacher who took theirs', async () => {
      await post('/api/v1/cover', {
        sectionId: sectionA, date: DAY, coveringStaffId: subStaffId, absentStaffId, reason: 'Fever',
      });

      const mineSub = await get('/api/v1/cover/mine', subCookies);
      expect(mineSub.status).toBe(200);
      expect(mineSub.body.covering).toHaveLength(1);
      // Direction matters: the substitute is COVERING, she is not being covered. Swapping the two
      // lists would tell each person the other one's news.
      expect(mineSub.body.covered).toEqual([]);

      const mineAway = await get('/api/v1/cover/mine', awayCookies);
      expect(mineAway.body.covering).toEqual([]);
      expect(mineAway.body.covered).toHaveLength(1);
      expect(mineAway.body.covered[0].coveringStaff.employeeCode).toBe('EMP-SUB');

      const subBell = kinds((await bell(subCookies)).body, 'COVERING_TODAY');
      expect(subBell).toHaveLength(1);
      expect(subBell[0].text).toContain('You are covering Grade 9-A today for T EMP-001');

      // Being covered without being told is how staff learn to distrust a system — and she is the
      // one person who can say the office picked the wrong class.
      const awayBell = kinds((await bell(awayCookies)).body, 'COVERED_TODAY');
      expect(awayBell).toHaveLength(1);
      expect(awayBell[0].text).toContain('T EMP-SUB is covering your Grade 9-A today');
    });

    it('takes both notices back when the cover is removed', async () => {
      const cover = await post('/api/v1/cover', { sectionId: sectionA, date: DAY, coveringStaffId: subStaffId, absentStaffId });
      expect(kinds((await bell(subCookies)).body, 'COVERING_TODAY')).toHaveLength(1);

      await del(`/api/v1/cover/${cover.body.id}`);
      // Derived, never stored: an item exists only while its cause does. A notice telling someone
      // to take a class that was reassigned an hour ago is the exact failure the no-table rule
      // exists to prevent.
      expect(kinds((await bell(subCookies)).body, 'COVERING_TODAY')).toEqual([]);
      expect(kinds((await bell(awayCookies)).body, 'COVERED_TODAY')).toEqual([]);
    });

    describe('responsibility moves with it (§6a)', () => {
      // The register reminder is silent until the school's own mark-by time has passed, and the
      // suite must not depend on the hour it runs at — the staff-attendance spec was green only
      // six days a week for exactly this kind of reason.
      const settings = (body: object) =>
        request(server()).patch('/api/v1/school-settings').set('Host', host)
          .set('Cookie', ownerCookies).set('X-CSRF-Token', ownerCsrf).send(body);

      beforeAll(async () => { await settings({ attendanceMarkByTime: '00:01' }); });
      afterAll(async () => { await settings({ attendanceMarkByTime: '10:00' }); });

      it('stops chasing the teacher who was away, and starts chasing the cover', async () => {
        const reminder = async (cookies: string[]) =>
          kinds((await bell(cookies)).body, 'REGISTER_UNMARKED');

        // Before: 9-A is Nadia's problem and nobody else's.
        expect(await reminder(awayCookies)).toHaveLength(1);
        expect(await reminder(subCookies)).toEqual([]);

        await post('/api/v1/cover', { sectionId: sectionA, date: DAY, coveringStaffId: subStaffId, absentStaffId });

        // After: it is the cover's. Nadia still teaches 9-B, so she keeps a reminder — the count
        // moved, not the whole notice, which is what makes this a real re-attribution rather than
        // "silence the absent teacher".
        const nadia = await reminder(awayCookies);
        expect(nadia).toHaveLength(1);
        expect(nadia[0].text).toContain('One of your registers');
        // Fatima teaches nothing at all. Any reminder she has is cover, and only cover.
        expect(await reminder(subCookies)).toHaveLength(1);
      });

      it('names the cover on the head teacher’s unmarked list', async () => {
        await post('/api/v1/cover', { sectionId: sectionA, date: DAY, coveringStaffId: subStaffId });
        const res = await get('/api/v1/attendance/unmarked-today');

        const a = res.body.sections.find((s: { sectionName: string }) => s.sectionName === 'A');
        const b = res.body.sections.find((s: { sectionName: string }) => s.sectionName === 'B');
        // A covered-but-unmarked register is still worth chasing — but a row naming the teacher who
        // was away sends the head to somebody who could not have marked it.
        expect(a.coveredBy).toBe('T EMP-SUB');
        expect(b?.coveredBy ?? null).toBeNull();
      });
    });
  });

  // ── C4: the edges of the grant ────────────────────────────────────────────
  describe('what cover is NOT (C4)', () => {
    it('does not let the cover enter exam marks for that class', async () => {
      await post('/api/v1/cover', { sectionId: sectionA, date: DAY, coveringStaffId: subStaffId });
      // She can mark the register — that is the grant working.
      expect((await subMarks(sectionA, DAY)).status).toBe(200);

      const yearId = (await get('/api/v1/academic-years')).body.find((y: { isCurrent: boolean }) => y.isCurrent).id;
      const term = await post('/api/v1/terms', { academicYearId: yearId, name: 'Term 1', startDate: '2026-04-01', endDate: '2026-09-30' });
      expect(term.status).toBe(201);
      const subjectId = (await get(`/api/v1/subjects?classId=${classId}`)).body[0].id;
      const exam = await post('/api/v1/exams', {
        termId: term.body.id, classId, name: 'Mid Term', examType: 'MID_TERM', weightagePercent: 30, examDate: DAY,
      });
      // Asserted, not assumed: an unchecked create leaves `undefined` in the next URL, and the API
      // answers a non-uuid path param with a 500 — which reads as "the feature is broken" when it
      // only means the fixture is.
      expect(exam.status).toBe(201);
      expect((await post(`/api/v1/exams/${exam.body.id}/open-marks-entry`)).status).toBe(201);

      const res = await request(server()).post(`/api/v1/exams/${exam.body.id}/results/bulk`)
        .set('Host', host).set('Cookie', subCookies).set('X-CSRF-Token', subCsrf)
        .send({ records: [{ enrollmentId: enrolmentA, subjectId, totalMarks: 100, marksObtained: 80 }] });

      // ⚠️ **Cover is a day's attendance, not a teaching relationship.** Marks are the class's
      // academic record and outlive the day entirely; whoever stood in for one lesson has no basis
      // to grade the term. Marks entry asks `TeacherAssignment` and deliberately never consults
      // cover — this locks that in, so a future "reuse coversSectionOn here" cannot widen the grant
      // silently. §25.3 partial-failure shape, so the refusal is per row inside a 200.
      expect(res.status).toBe(200);
      expect(res.body.succeeded).toBe(0);
      expect(JSON.stringify(res.body.errors)).toContain('Not assigned to this section/subject');

      await platform.examResult.deleteMany({ where: { schoolId } });
      await platform.examDefinition.deleteMany({ where: { schoolId } });
      await platform.term.deleteMany({ where: { schoolId } });
    });

    describe('the campus boundary', () => {
      let otherCampus: string;
      let otherSection: string;
      let campusAdmin: string[];
      let crossCampusAssignment: string;

      beforeAll(async () => {
        otherCampus = (await post('/api/v1/campuses', { name: 'North Campus' })).body.id;
        const otherClass = (await post('/api/v1/classes', { campusId: otherCampus, name: 'Grade 10', order: 10 })).body.id;
        otherSection = (await post('/api/v1/sections', { classId: otherClass, name: 'A' })).body.id;

        // ⚠️ Nadia teaches at BOTH campuses, and that is what makes the filter observable. Without
        // this the away-list test passed with the campus filter deleted — she had nothing at the
        // far campus, so there was nothing for a leak to expose. A boundary test needs something on
        // the wrong side of the boundary.
        const yearId = (await get('/api/v1/academic-years')).body.find((y: { isCurrent: boolean }) => y.isCurrent).id;
        const otherSubject = (await post('/api/v1/subjects', { classId: otherClass, name: 'Physics' })).body.id;
        const a = await post('/api/v1/teacher-assignments', { staffId: absentStaffId, academicYearId: yearId, sectionId: otherSection, subjectId: otherSubject });
        expect(a.status).toBe(201);
        crossCampusAssignment = a.body.id;

        // A campus admin bound to the ORIGINAL campus. The scoping rule has been written three
        // times across C1–C3 and never watched fail; a second campus is the only way to see it.
        const email = 'campusadmin@cv.pk';
        const user = await post('/api/v1/users', { email, roles: ['CAMPUS_ADMIN'], campusId, password: 'Campus!Secret12' });
        expect([201, 200]).toContain(user.status);
        campusAdmin = await login(email, 'Campus!Secret12');
      });

      const asCampusAdmin = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', campusAdmin);

      it('refuses cover for a class at another campus', async () => {
        const res = await request(server()).post('/api/v1/cover').set('Host', host)
          .set('Cookie', campusAdmin).set('X-CSRF-Token', csrfOf(campusAdmin))
          .send({ sectionId: otherSection, date: DAY, coveringStaffId: subStaffId });
        expect(res.status).toBe(403);
      });

      it('keeps another campus out of the cover list and the suggestions', async () => {
        // The owner arranges cover at BOTH campuses, so there is something at each to leak.
        await post('/api/v1/cover', { sectionId: sectionA, date: DAY, coveringStaffId: subStaffId });
        await post('/api/v1/cover', { sectionId: otherSection, date: DAY, coveringStaffId: subStaffId });
        expect((await get(`/api/v1/cover?date=${DAY}`)).body.cover).toHaveLength(2);

        // Populating only the far campus and expecting [] would pass with the scoping ignored —
        // there would be nothing to land on. Both are populated, so the count is the assertion.
        const mine = (await asCampusAdmin(`/api/v1/cover?date=${DAY}`)).body.cover;
        expect(mine).toHaveLength(1);
        expect(mine[0].section.id).toBe(sectionA);

        // Suggestions for a section at the other campus is not theirs to ask.
        expect((await asCampusAdmin(`/api/v1/cover/suggestions?sectionId=${otherSection}&date=${DAY}`)).status).toBe(403);
        expect((await asCampusAdmin(`/api/v1/cover/suggestions?sectionId=${sectionA}&date=${DAY}`)).status).toBe(200);
      });

      it('shows an away teacher only the classes this admin could arrange', async () => {
        await post('/api/v1/staff-attendance/bulk', {
          date: DAY, session: 'MORNING', allowHolidayOverride: true,
          records: [{ staffId: absentStaffId, status: 'ABSENT' }],
        });

        // The owner sees all three of Nadia's classes — 9-A, 9-B here and 10-A at North.
        expect((await get(`/api/v1/cover/away?date=${DAY}`)).body.away[0].sections).toHaveLength(3);

        const res = await asCampusAdmin(`/api/v1/cover/away?date=${DAY}`);
        // The campus admin sees the two that are theirs to arrange, and she is still LISTED — a
        // filter that dropped the colleague entirely would be just as wrong as one that leaked
        // the far campus.
        expect(res.body.away).toHaveLength(1);
        expect(res.body.away[0].sections.map((s: { sectionId: string }) => s.sectionId).sort())
          .toEqual([sectionA, sectionB].sort());
        await platform.staffAttendance.deleteMany({ where: { schoolId } });
      });

      afterAll(async () => {
        // Put the fixture back: every earlier case assumes Nadia teaches exactly this campus.
        await platform.teacherAssignment.delete({ where: { id: crossCampusAssignment } });
      });
    });
  });

  it('never lets a teacher arrange their own cover', async () => {
    const res = await request(server()).post('/api/v1/cover').set('Host', host)
      .set('Cookie', subCookies).set('X-CSRF-Token', subCsrf)
      .send({ sectionId: sectionA, date: DAY, coveringStaffId: subStaffId });
    // Arranging cover is a permission grant; if the person who benefits could issue it, the
    // boundary it is meant to enforce would not exist.
    expect(res.status).toBe(403);
  });
});
