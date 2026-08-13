import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../apps/api/src/app.module';
import { PlatformPrismaService } from '@database';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { admissionController } from './support/admission';
import { destroyTenant } from './support/tenant';
import { loginRequest } from './support/login';

/**
 * M2 milestone gate (roadmap M2): the ADMIT journey end-to-end —
 * provision -> login -> setup (year/class/section) -> inquiry -> schedule test ->
 * record pass -> admit -> student + primary guardian + active enrollment created ->
 * directory search finds them -> transfer moves the enrollment. Runs the real
 * guards/interceptor/RLS stack over HTTP.
 */
describe('Admit journey (e2e, §8)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let campusId: string;
  let cookies: string[];
  let csrf: string;
  let acPost: (path: string, body: object) => request.Test; // admit runs as the admission controller (§8)
  const sub = `adm-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const ownerEmail = 'owner@demo.pk';
  const ownerPassword = 'Owner!Secret12';

  const server = () => app.getHttpServer();
  const csrfOf = (setCookies: string[]) =>
    (setCookies.find((c) => c.startsWith('csrf=')) ?? '').split(';')[0].slice('csrf='.length);

  const post = (path: string, body: object) =>
    request(server()).post(path).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).send(body);
  const patch = (path: string, body: object) =>
    request(server()).patch(path).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).send(body);
  const get = (path: string) => request(server()).get(path).set('Host', host).set('Cookie', cookies);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const provisioning = app.get(ProvisioningService, { strict: false });
    const res = await provisioning.provisionSchool({
      name: 'Demo School',
      subdomain: sub,
      ownerEmail,
      ownerPassword,
    });
    schoolId = res.schoolId;
    campusId = res.campusId;

    const login = await loginRequest(server(), host, ownerEmail, ownerPassword);
    expect(login.status).toBe(200);
    cookies = login.headers['set-cookie'] as unknown as string[];
    csrf = csrfOf(cookies);

    // Student creation (admit) is admission-controller-only; the inquiry pipeline stays owner.
    const ac = await admissionController(app, platform, schoolId, host, campusId);
    acPost = (path: string, body: object) =>
      request(server()).post(path).set('Host', host).set('Cookie', ac.cookies).set('X-CSRF-Token', ac.csrf).send(body);
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  let classId: string;
  let sectionId: string;
  let inquiryId: string;
  let studentId: string;

  it('sets up an academic year, class and section', async () => {
    const year = await post('/api/v1/academic-years', {
      name: '2026-27',
      startDate: '2026-04-01',
      endDate: '2027-03-31',
      isCurrent: true,
    });
    expect(year.status).toBe(201);
    expect(year.body.isCurrent).toBe(true);

    const klass = await post('/api/v1/classes', { campusId, name: 'Grade 1', order: 1 });
    expect(klass.status).toBe(201);
    classId = klass.body.id;

    const section = await post('/api/v1/sections', { classId, name: 'A', capacity: 40 });
    expect(section.status).toBe(201);
    sectionId = section.body.id;
  });

  it('runs the inquiry through the state machine to a pass', async () => {
    const inquiry = await post('/api/v1/inquiries', {
      campusId,
      guardianName: 'Ali Khan',
      guardianPhone: '03001234567',
      studentName: 'Sara Khan',
      desiredClassId: classId,
    });
    expect(inquiry.status).toBe(201);
    inquiryId = inquiry.body.id;
    expect(inquiry.body.status).toBe('INQUIRY');

    const sched = await post(`/api/v1/inquiries/${inquiryId}/entry-test`, { scheduledAt: '2026-03-15T09:00:00.000Z' });
    expect(sched.status).toBe(201);
    expect(sched.body.status).toBe('ENTRY_TEST_SCHEDULED');

    const result = await patch(`/api/v1/inquiries/${inquiryId}/entry-test`, { passed: true, score: 82 });
    expect(result.status).toBe(200);
    expect(result.body.status).toBe('ENTRY_TEST_PASSED');
  });

  it('admits the student: creates student + primary guardian + active enrollment', async () => {
    const admit = await acPost('/api/v1/admissions', {
      inquiryId,
      gender: 'FEMALE',
      dateOfBirth: '2020-05-10',
      classId,
      sectionId,
      guardian: { mode: 'CREATE', fullName: 'Ali Khan', phone: '03001234567', relation: 'FATHER' },
    });
    expect(admit.status).toBe(201);
    studentId = admit.body.studentId;
    expect(admit.body.grNumber).toBeTruthy();
    expect(admit.body.enrollmentId).toBeTruthy();

    const student = await get(`/api/v1/students/${studentId}`);
    expect(student.status).toBe(200);
    expect(student.body.fullName).toBe('Sara Khan');
    const primaries = student.body.guardians.filter((g: { isPrimary: boolean }) => g.isPrimary);
    expect(primaries).toHaveLength(1);
    const active = student.body.enrollments.filter((e: { status: string }) => e.status === 'ACTIVE');
    expect(active).toHaveLength(1);
  });

  // Scope B (2026-07-29): parents do not get logins, so admitting a student must NOT mint a
  // login-less User + `p-<uuid>@invite.local` placeholder for the guardian. The guardian is a
  // ParentProfile and nothing else. Guards against the waste that once left 557 dead accounts.
  it('creating a guardian mints no User account', async () => {
    const parents = await platform.parentProfile.findMany({ where: { schoolId } });
    expect(parents.length).toBeGreaterThanOrEqual(1);
    expect(parents.every((p) => p.userId === null)).toBe(true);

    expect(await platform.user.count({ where: { schoolId, roles: { has: 'PARENT' } } })).toBe(0);
    expect(await platform.user.count({ where: { schoolId, email: { endsWith: '@invite.local' } } })).toBe(0);
  });

  // The guardian's email used to live on that User row. It is contact data the admission form
  // collects, so retiring the row moved it onto the profile rather than dropping it.
  it('keeps the guardian email on the profile, and it is not a login', async () => {
    const email = `guardian-${Date.now()}@demo.pk`;
    const inq = await post('/api/v1/inquiries', {
      campusId, guardianName: 'Email Guardian', guardianPhone: '03004440000',
      studentName: 'Email Child', desiredClassId: classId,
    });
    expect(inq.status).toBe(201);
    await post(`/api/v1/inquiries/${inq.body.id}/entry-test`, { scheduledAt: '2026-03-15T09:00:00.000Z' });
    await patch(`/api/v1/inquiries/${inq.body.id}/entry-test`, { passed: true, score: 75 });
    const admitted = await acPost('/api/v1/admissions', {
      inquiryId: inq.body.id, gender: 'MALE', dateOfBirth: '2019-03-02', classId, sectionId,
      guardian: { mode: 'CREATE', fullName: 'Email Guardian', phone: '03004440000', relation: 'FATHER', email },
    });
    expect(admitted.status).toBe(201);

    const parent = await platform.parentProfile.findFirst({ where: { schoolId, phone: '+923004440000' } });
    expect(parent?.email).toBe(email);
    expect(parent?.userId).toBeNull();
    // Stored as contact data only — it buys no account and no way in.
    expect(await platform.user.count({ where: { schoolId, email } })).toBe(0);
  });

  it('re-admitting the same inquiry is a 409 INVALID_STATE_TRANSITION', async () => {
    const res = await acPost('/api/v1/admissions', {
      inquiryId,
      gender: 'FEMALE',
      dateOfBirth: '2020-05-10',
      classId,
      sectionId,
      guardian: { mode: 'CREATE', fullName: 'Ali Khan', phone: '03009999999', relation: 'FATHER' },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('finds the student in the directory by name and by guardian phone', async () => {
    const byName = await get('/api/v1/students?search=Sara');
    expect(byName.status).toBe(200);
    expect(byName.body.data.some((s: { id: string }) => s.id === studentId)).toBe(true);

    const byPhone = await get('/api/v1/students?search=03001234567');
    expect(byPhone.body.data.some((s: { id: string }) => s.id === studentId)).toBe(true);
  });

  it('transfers the student to another section (close old, open new)', async () => {
    const sectionB = await post('/api/v1/sections', { classId, name: 'B', capacity: 40 });
    const toSectionId = sectionB.body.id;

    const transfer = await post('/api/v1/enrollments/transfer', { studentId, toSectionId });
    expect(transfer.status).toBe(201);
    expect(transfer.body.sectionId).toBe(toSectionId);
    expect(transfer.body.status).toBe('ACTIVE');

    const active = await get(`/api/v1/enrollments?studentId=${studentId}&status=ACTIVE`);
    expect(active.body.data).toHaveLength(1);
    expect(active.body.data[0].sectionId).toBe(toSectionId);
  });

  /**
   * Student Transfer Plan, X0 — the three gaps the endpoint shipped with.
   *
   * A transfer **relocates a child**, including across campuses, and it had no campus check, no
   * capacity check and no permission-matrix row. The matrix row is what found a fourth: `GET
   * /enrollments` had no `@Roles` at all.
   */
  describe('the limits on a transfer (X0)', () => {
    /** A second admitted child, so a capacity test has somebody to be refused. */
    const admitSecondStudent = async (): Promise<string> => {
      const inq = await post('/api/v1/inquiries', {
        campusId, guardianName: 'Cap Guardian', guardianPhone: '03005550000',
        studentName: 'Cap Child', desiredClassId: classId,
      });
      await post(`/api/v1/inquiries/${inq.body.id}/entry-test`, { scheduledAt: '2026-03-15T09:00:00.000Z' });
      await patch(`/api/v1/inquiries/${inq.body.id}/entry-test`, { passed: true, score: 80 });
      const admitted = await acPost('/api/v1/admissions', {
        inquiryId: inq.body.id, gender: 'MALE', dateOfBirth: '2019-06-02', classId, sectionId,
        guardian: { mode: 'CREATE', fullName: 'Cap Guardian', phone: '03005550000', relation: 'FATHER' },
      });
      expect(admitted.status).toBe(201);
      return admitted.body.studentId as string;
    };

    it('refuses a campus-bound admin moving a student to another campus', async () => {
      const otherCampus = await post('/api/v1/campuses', { name: 'North Campus' });
      const otherClass = await post('/api/v1/classes', { campusId: otherCampus.body.id, name: 'Grade 5', order: 5 });
      const otherSection = await post('/api/v1/sections', { classId: otherClass.body.id, name: 'A', capacity: 40 });

      const email = 'campusadmin@adm.pk';
      const created = await post('/api/v1/users', { email, roles: ['CAMPUS_ADMIN'], campusId, password: 'Campus!Secret12' });
      expect([200, 201]).toContain(created.status);
      const caLogin = await loginRequest(server(), host, email, 'Campus!Secret12');
      expect(caLogin.status).toBe(200);
      const caCookies = caLogin.headers['set-cookie'] as unknown as string[];
      const caCsrf = csrfOf(caCookies);

      // ── Direction 1: pushing a child OUT of their campus. Source is theirs, destination is not.
      const pushOut = await request(app.getHttpServer()).post('/api/v1/enrollments/transfer')
        .set('Host', host).set('Cookie', caCookies).set('X-CSRF-Token', caCsrf)
        .send({ studentId, toSectionId: otherSection.body.id });
      expect(pushOut.status).toBe(403);

      // ── Direction 2: pulling a child IN. Destination is theirs, source is not.
      //
      // ⚠️ **This case exists because a probe found nothing to break.** With only direction 1,
      // deleting the source-end check failed no test — the destination check caught that move on
      // its own. Only an admin of the FAR campus can distinguish the two, and without them "both
      // ends" was a claim in a comment rather than a tested rule.
      const farEmail = 'northadmin@adm.pk';
      await post('/api/v1/users', { email: farEmail, roles: ['CAMPUS_ADMIN'], campusId: otherCampus.body.id, password: 'North!Secret12' });
      const farLogin = await loginRequest(server(), host, farEmail, 'North!Secret12');
      const farCookies = farLogin.headers['set-cookie'] as unknown as string[];

      const pullIn = await request(app.getHttpServer()).post('/api/v1/enrollments/transfer')
        .set('Host', host).set('Cookie', farCookies).set('X-CSRF-Token', csrfOf(farCookies))
        .send({ studentId, toSectionId: otherSection.body.id });
      expect(pullIn.status).toBe(403);

      // ...and the owner, who is school-wide, may do exactly the same move.
      const asOwner = await post('/api/v1/enrollments/transfer', { studentId, toSectionId: otherSection.body.id });
      expect(asOwner.status).toBe(201);
      // Put the student back so later assertions and other specs see the fixture they expect.
      const backTo = await get(`/api/v1/sections?classId=${classId}`);
      await post('/api/v1/enrollments/transfer', { studentId, toSectionId: backTo.body[0].id });
    });

    /**
     * The same "check the PAIR, not the caller" gap, on the two other writes that link a staff
     * member to a section. All three were found together: every campus guard in the codebase asks
     * *may you touch this?*, which an owner always may, so nothing compared the two things being
     * linked. The assignment saved, the teacher's home said "Mark 9-A", and attendance then refused
     * them for being at another campus.
     */
    it('refuses linking a teacher to a class at another campus, even for the owner', async () => {
      const north = await post('/api/v1/campuses', { name: 'Far Campus' });
      const northClass = await post('/api/v1/classes', { campusId: north.body.id, name: 'Grade 7', order: 7 });
      const northSection = await post('/api/v1/sections', { classId: northClass.body.id, name: 'A', capacity: 40 });
      const northSubject = await post('/api/v1/subjects', { classId: northClass.body.id, name: 'Physics' });
      const yearId = (await get('/api/v1/academic-years')).body.find((y: { isCurrent: boolean }) => y.isCurrent).id;

      // A teacher of the ORIGINAL campus.
      const teacher = await post('/api/v1/staff', {
        email: `t-${Date.now()}@adm.pk`, campusId, staffType: 'TEACHER', employeeCode: `E-${Date.now()}`,
        designation: 'Teacher', joinedAt: '2026-04-01', fullName: 'Local Teacher',
      });
      expect(teacher.status).toBe(201);

      const assign = await post('/api/v1/teacher-assignments', {
        staffId: teacher.body.staffId, academicYearId: yearId, sectionId: northSection.body.id, subjectId: northSubject.body.id,
      });
      // 422, not 403: nobody's permissions are at fault — the pair is invalid.
      expect(assign.status).toBe(422);
      expect(assign.body.error.message).toContain('belongs to a different campus');

      const slot = await post('/api/v1/timetable/slots', {
        sectionId: northSection.body.id, dayOfWeek: 1, periodNo: 1,
        subjectId: northSubject.body.id, staffId: teacher.body.staffId,
      });
      // A grid that puts a campus-A teacher in a campus-B room renders perfectly and cannot be
      // taught, which is why this needs the same rule rather than a comment about it.
      expect(slot.status).toBe(422);
      expect(slot.body.error.message).toContain('belongs to a different campus');

      // ...and the same teacher in their OWN campus is still accepted, so this is a boundary and
      // not a blanket refusal.
      const ok = await post('/api/v1/teacher-assignments', {
        staffId: teacher.body.staffId, academicYearId: yearId, sectionId, subjectId: undefined,
      });
      expect(ok.status).toBe(201);
    });

    it('refuses a move into a full section when the school caps them', async () => {
      await request(app.getHttpServer()).patch('/api/v1/school-settings').set('Host', host)
        .set('Cookie', cookies).set('X-CSRF-Token', csrf).send({ sectionCapacityMode: 'HARD' });
      // One seat, and the child already in the class is not in it — so the section is empty and the
      // move must succeed, then the SECOND child must be refused. Capacity tests that only ever
      // assert a refusal cannot tell a working rule from a broken endpoint.
      const tiny = await post('/api/v1/sections', { classId, name: 'T', capacity: 1 });
      const first = await post('/api/v1/enrollments/transfer', { studentId, toSectionId: tiny.body.id });
      expect(first.status).toBe(201);

      const second = await admitSecondStudent();
      const res = await post('/api/v1/enrollments/transfer', { studentId: second, toSectionId: tiny.body.id });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('SECTION_FULL');

      await request(app.getHttpServer()).patch('/api/v1/school-settings').set('Host', host)
        .set('Cookie', cookies).set('X-CSRF-Token', csrf).send({ sectionCapacityMode: 'ADVISORY' });
      // ADVISORY is not "no rule" — it is the school saying its class sizes are guidance, and the
      // write must go through so the UI can warn instead of the API refusing.
      const advisory = await post('/api/v1/enrollments/transfer', { studentId: second, toSectionId: tiny.body.id });
      expect(advisory.status).toBe(201);
    });
  });
});
