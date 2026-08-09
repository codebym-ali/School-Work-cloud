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
 * Timetable (§23) — the grid, and the rules that stop it lying.
 *
 * `timetable_slots` existed from the first schema and **nothing could write it**: raw ids, no
 * relations, no endpoint, and two delete-guards counting a number that was structurally always
 * zero. Everything here is therefore new behaviour rather than a regression net, so the cases
 * chosen are the ones a real timetable gets wrong: the same teacher in two rooms at once, a
 * subject scheduled for a class that does not study it, and a teacher who has left.
 */
describe('Timetable (e2e, §23)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let campusId: string;
  let ownerCookies: string[];
  let ownerCsrf: string;
  let teacherCookies: string[];
  let studentCookies: string[];
  let classId: string;
  let sectionA: string;
  let sectionB: string;
  let otherClassId: string;
  let otherSection: string;
  let mathId: string;
  let otherSubjectId: string;
  let teacherId: string;
  let secondTeacherId: string;

  const sub = `tt-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@tt.pk', password: 'Owner!Secret12' };
  const studentLogin = { email: 'ayesha@tt.local', password: 'Student!Secret12' };
  const teacher = { email: 'teacher@tt.pk', password: 'Teach!Secret12' };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object = {}) =>
    request(server()).post(p).set('Host', host).set('Cookie', ownerCookies).set('X-CSRF-Token', ownerCsrf).send(b);
  const del = (p: string) =>
    request(server()).delete(p).set('Host', host).set('Cookie', ownerCookies).set('X-CSRF-Token', ownerCsrf);
  const get = (p: string, cookies = ownerCookies) => request(server()).get(p).set('Host', host).set('Cookie', cookies);
  const login = async (e: string, pw: string) => {
    const res = await request(server()).post('/api/v1/auth/login').set('Host', host).send({ email: e, password: pw });
    return res.headers['set-cookie'] as unknown as string[];
  };
  const setSlot = (b: object) => post('/api/v1/timetable/slots', b);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const prov = await app.get(ProvisioningService, { strict: false }).provisionSchool({
      name: 'TT School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password,
    });
    schoolId = prov.schoolId;
    campusId = prov.campusId;

    ownerCookies = await login(owner.email, owner.password);
    ownerCsrf = csrfOf(ownerCookies);
    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });

    classId = (await post('/api/v1/classes', { campusId, name: 'Grade 9', order: 9 })).body.id;
    sectionA = (await post('/api/v1/sections', { classId, name: 'A' })).body.id;
    sectionB = (await post('/api/v1/sections', { classId, name: 'B' })).body.id;
    mathId = (await post('/api/v1/subjects', { classId, name: 'Mathematics' })).body.id;

    otherClassId = (await post('/api/v1/classes', { campusId, name: 'Grade 2', order: 2 })).body.id;
    otherSection = (await post('/api/v1/sections', { classId: otherClassId, name: 'A' })).body.id;
    otherSubjectId = (await post('/api/v1/subjects', { classId: otherClassId, name: 'Nazra' })).body.id;

    // A STUDENT session, so the student half of `/timetable/mine` is exercised by a real student
    // rather than inferred from the teacher path. Admitting needs the admission-officer seat
    // (§8), hence the shared helper; the login itself is an ordinary email/password user with
    // `roles: ['STUDENT']` linked to the Student record through `Student.userId`.
    const { admit } = await admissionController(app, platform, schoolId, host, campusId);
    const student = await admit({
      fullName: 'Ayesha Malik', gender: 'FEMALE', dateOfBirth: '2011-05-10',
      campusId, classId, sectionId: sectionA,
      guardian: { mode: 'CREATE', fullName: 'Asif Malik', phone: '03001234567', relation: 'FATHER' },
    });
    const studentUser = await platform.user.create({
      data: {
        schoolId, email: studentLogin.email, roles: ['STUDENT'] as never, status: 'ACTIVE',
        passwordHash: await argon2.hash(studentLogin.password, { type: argon2.argon2id }),
      },
    });
    await platform.student.update({ where: { id: student.body.studentId }, data: { userId: studentUser.id } });
    studentCookies = await login(studentLogin.email, studentLogin.password);

    // A classmate in section B, with no login. Purely so the scoping test can FAIL: with one
    // enrolment in the school, a `findFirst` that ignored the caller entirely would still land on
    // the right row, and the test would pass while proving nothing. Probed exactly that way.
    await admit({
      fullName: 'Bilal Ahmed', gender: 'MALE', dateOfBirth: '2011-06-12',
      campusId, classId, sectionId: sectionB,
      guardian: { mode: 'CREATE', fullName: 'Rashid Ahmed', phone: '03009876543', relation: 'FATHER' },
    });

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
    teacherId = await mkStaff(teacher.email, 'EMP-001', teacher.password);
    secondTeacherId = await mkStaff('second@tt.pk', 'EMP-002');
    teacherCookies = await login(teacher.email, teacher.password);
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  afterEach(async () => {
    await platform.timetableSlot.deleteMany({ where: { schoolId } });
  });

  it('fills a cell and reads the section back', async () => {
    const res = await setSlot({ sectionId: sectionA, dayOfWeek: 1, periodNo: 1, subjectId: mathId, staffId: teacherId, room: 'Lab 2' });
    expect(res.status).toBe(201);

    const grid = await get(`/api/v1/timetable/section/${sectionA}`);
    expect(grid.body.slots).toHaveLength(1);
    // The join is the point of TT0: before relations existed, a grid could only have shown uuids.
    expect(grid.body.slots[0].subject.name).toBe('Mathematics');
    expect(grid.body.slots[0].staff.employeeCode).toBe('EMP-001');
    expect(grid.body.slots[0].room).toBe('Lab 2');
  });

  it('replaces a cell rather than stacking a second lesson into it', async () => {
    await setSlot({ sectionId: sectionA, dayOfWeek: 1, periodNo: 1, subjectId: mathId, staffId: teacherId });
    const again = await setSlot({ sectionId: sectionA, dayOfWeek: 1, periodNo: 1, subjectId: mathId, staffId: secondTeacherId });
    expect(again.status).toBe(201);

    const grid = await get(`/api/v1/timetable/section/${sectionA}`);
    expect(grid.body.slots).toHaveLength(1);
    expect(grid.body.slots[0].staff.employeeCode).toBe('EMP-002');
  });

  it('refuses to put one teacher in two sections at the same moment', async () => {
    await setSlot({ sectionId: sectionA, dayOfWeek: 1, periodNo: 3, subjectId: mathId, staffId: teacherId });
    const clash = await setSlot({ sectionId: sectionB, dayOfWeek: 1, periodNo: 3, subjectId: mathId, staffId: teacherId });

    expect(clash.status).toBe(409);
    // Naming the clash is the whole value: "conflict" alone leaves whoever is building the grid
    // hunting for which class already has that teacher.
    expect(clash.body.error.message).toContain('Grade 9-A');
    expect(clash.body.error.message).toContain('period 3');
  });

  it('lets the same teacher take the same period on a different day', async () => {
    await setSlot({ sectionId: sectionA, dayOfWeek: 1, periodNo: 3, subjectId: mathId, staffId: teacherId });
    const tuesday = await setSlot({ sectionId: sectionB, dayOfWeek: 2, periodNo: 3, subjectId: mathId, staffId: teacherId });
    expect(tuesday.status).toBe(201); // not a clash — a timetable that forbade this would be useless
  });

  it('does not treat editing a cell as clashing with itself', async () => {
    await setSlot({ sectionId: sectionA, dayOfWeek: 1, periodNo: 4, subjectId: mathId, staffId: teacherId });
    const sameCell = await setSlot({ sectionId: sectionA, dayOfWeek: 1, periodNo: 4, subjectId: mathId, staffId: teacherId, room: 'Room 5' });
    expect(sameCell.status).toBe(201);
    expect(sameCell.body.room).toBe('Room 5');
  });

  it('refuses a subject the class does not study', async () => {
    // Both ids resolve, and the grid would have rendered perfectly — which is exactly why this
    // needs checking rather than trusting the UI to only offer the right list.
    const res = await setSlot({ sectionId: sectionA, dayOfWeek: 1, periodNo: 5, subjectId: otherSubjectId, staffId: teacherId });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('not taught in this class');
  });

  it('refuses a teacher who has left', async () => {
    await platform.staffProfile.update({ where: { id: secondTeacherId }, data: { leftAt: new Date('2026-06-30') } });
    const res = await setSlot({ sectionId: sectionA, dayOfWeek: 2, periodNo: 1, subjectId: mathId, staffId: secondTeacherId });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('has left');
    await platform.staffProfile.update({ where: { id: secondTeacherId }, data: { leftAt: null } });
  });

  it('clears a cell, and clearing an empty one is not an error', async () => {
    const slot = await setSlot({ sectionId: sectionA, dayOfWeek: 3, periodNo: 2, subjectId: mathId, staffId: teacherId });
    expect((await del(`/api/v1/timetable/slots/${slot.body.id}`)).body.deleted).toBe(true);
    // Idempotent: two admins clearing the same cell must not produce a 404 for the slower one.
    expect((await del(`/api/v1/timetable/slots/${slot.body.id}`)).body.deleted).toBe(false);
  });

  it('gives a teacher their own periods without them naming themselves', async () => {
    await setSlot({ sectionId: sectionA, dayOfWeek: 1, periodNo: 1, subjectId: mathId, staffId: teacherId });
    await setSlot({ sectionId: sectionB, dayOfWeek: 1, periodNo: 2, subjectId: mathId, staffId: secondTeacherId });

    const mine = await get('/api/v1/timetable/mine', teacherCookies);
    expect(mine.status).toBe(200);
    expect(mine.body.as).toBe('TEACHER');
    // Theirs only. The request carries no id, so there is no parameter to widen.
    expect(mine.body.slots).toHaveLength(1);
    expect(mine.body.slots[0].staff.employeeCode).toBe('EMP-001');
  });

  it('gives an account that is neither staff nor enrolled an empty week, not a 403', async () => {
    await setSlot({ sectionId: sectionA, dayOfWeek: 1, periodNo: 1, subjectId: mathId, staffId: teacherId });
    // The owner has no staff profile and no enrolment. This is read by a portal page, where a 403
    // reads as a fault rather than as "not yours" — so the branch returns an empty week.
    const res = await get('/api/v1/timetable/mine');
    expect(res.status).toBe(200);
    expect(res.body.as).toBe('NONE');
    expect(res.body.slots).toEqual([]);
  });

  // ── the STUDENT half of `mine()` ──────────────────────────────────────────
  // Covered 2026-08-09. This block used to carry a note saying it could not be tested without the
  // registration-number/CNIC auth path — **that was wrong**. A student login is an ordinary
  // email/password `User` with `roles: ['STUDENT']` joined to the Student row through
  // `Student.userId`, exactly as `student-portal.e2e-spec` builds it. The note had turned an hour
  // of fixture work into a permanent excuse; checking cost ten minutes.

  it("gives a student their own section's week", async () => {
    await setSlot({ sectionId: sectionA, dayOfWeek: 1, periodNo: 1, subjectId: mathId, staffId: teacherId, room: 'Lab 2' });
    await setSlot({ sectionId: sectionA, dayOfWeek: 3, periodNo: 2, subjectId: mathId, staffId: teacherId });

    const res = await get('/api/v1/timetable/mine', studentCookies);
    expect(res.status).toBe(200);
    // The branch is chosen by what the caller IS, not by anything they send — no staff profile,
    // one active enrolment, so the enrolment's section is the answer.
    expect(res.body.as).toBe('STUDENT');
    expect(res.body.slots).toHaveLength(2);
    expect(res.body.slots.map((x: { periodNo: number }) => x.periodNo)).toEqual([1, 2]);
    expect(res.body.slots[0].subject.name).toBe('Mathematics');
    expect(res.body.slots[0].room).toBe('Lab 2');
  });

  it("never shows a student another section's week", async () => {
    // BOTH sections get a lesson, and they are told apart only by period number. Asserting the
    // student sees *their* slot rather than *no* slot is what makes this able to fail: an earlier
    // version populated only section B and expected `[]`, which passed even with the caller
    // ignored entirely — proved by probing it. A test that cannot fail is not coverage.
    await setSlot({ sectionId: sectionA, dayOfWeek: 2, periodNo: 1, subjectId: mathId, staffId: teacherId });
    await setSlot({ sectionId: sectionB, dayOfWeek: 2, periodNo: 4, subjectId: mathId, staffId: secondTeacherId });

    const res = await get('/api/v1/timetable/mine', studentCookies);
    expect(res.body.as).toBe('STUDENT');
    expect(res.body.slots).toHaveLength(1);
    expect(res.body.slots[0].periodNo).toBe(1);          // section A's, not section B's
    expect(res.body.slots[0].section.id).toBe(sectionA);
  });

  it('stops showing a week once the enrolment is no longer active', async () => {
    await setSlot({ sectionId: sectionA, dayOfWeek: 1, periodNo: 1, subjectId: mathId, staffId: teacherId });
    expect((await get('/api/v1/timetable/mine', studentCookies)).body.slots).toHaveLength(1);

    // A withdrawn student is not in that class any more, and a timetable that kept showing them
    // its week would be telling them to turn up. `status: 'ACTIVE'` in the lookup is what stops it.
    await platform.studentEnrollment.updateMany({ where: { schoolId }, data: { status: 'WITHDRAWN' } });
    const after = await get('/api/v1/timetable/mine', studentCookies);
    expect(after.body.as).toBe('NONE');
    expect(after.body.slots).toEqual([]);
    await platform.studentEnrollment.updateMany({ where: { schoolId }, data: { status: 'ACTIVE' } });
  });


  it('reports which sections have no timetable yet', async () => {
    await setSlot({ sectionId: sectionA, dayOfWeek: 1, periodNo: 1, subjectId: mathId, staffId: teacherId });
    const cov = await get('/api/v1/timetable/coverage');
    const bySection = Object.fromEntries(cov.body.sections.map((s: { sectionId: string; slots: number }) => [s.sectionId, s.slots]));
    // A blank grid cannot tell "not built yet" from "built and empty", and only the first is
    // worth chasing — so the count is reported per section rather than left to the eye.
    expect(bySection[sectionA]).toBe(1);
    expect(bySection[sectionB]).toBe(0);
    expect(bySection[otherSection]).toBe(0);
  });

  it('keeps a subject that is on the timetable from being deleted', async () => {
    await setSlot({ sectionId: sectionA, dayOfWeek: 4, periodNo: 1, subjectId: mathId, staffId: teacherId });
    const res = await del(`/api/v1/subjects/${mathId}`);
    // The delete-guard that counted timetable slots has existed all along; until now the count it
    // read could only ever be zero, so it had never once refused anything.
    expect([409, 422]).toContain(res.status);
  });
});
