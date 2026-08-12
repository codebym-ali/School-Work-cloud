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
 * Class structure: a section's own subject list, and teacher assignments.
 *
 * Both are the backbone of the Classes screen and neither had behavioural coverage:
 *  - `PUT /sections/:id/subjects` shipped with only an authz row in the permission matrix, and
 *    no UI ever called it — so "which subjects does 9-B study?" could be set once at creation
 *    and never corrected.
 *  - `GET /teacher-assignments` returned EVERY year at once, so a client matching on
 *    (section, subject) saw last year's teacher as this year's and deleted the historical row
 *    when reassigning. It also scoped by the TEACHER's campus rather than the SECTION's, hiding
 *    assignments on a campus admin's own class.
 */
describe('Class structure — section subjects & teacher assignments (e2e)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;

  let campusA: string;
  let campusB: string;
  let ownerCookies: string[];
  let ownerCsrf: string;
  let adminCookies: string[]; // CAMPUS_ADMIN bound to campus A
  let adminCsrf: string;

  let lastYear: string;
  let thisYear: string;
  let classA: string;
  let sectionA: string;
  let sectionB: string;
  let classOnB: string;
  let sectionOnB: string;
  let maths: string;
  let science: string;
  let urdu: string;
  let foreignSubject: string; // belongs to the campus-B class
  let teacherOnA: string; // StaffProfile id, user campus A
  let teacherOnB: string; // StaffProfile id, user campus B

  const sub = `cst-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@cst.pk', password: 'Owner!Secret12' };
  const admin = { email: 'campadmin@cst.pk', password: 'Admin!Secret12' };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const authed = (method: 'get' | 'post' | 'put' | 'delete', p: string, cookies: string[], csrf?: string) => {
    let r = request(server())[method](p).set('Host', host).set('Cookie', cookies);
    if (csrf) r = r.set('X-CSRF-Token', csrf);
    return r;
  };
  const ownerPost = (p: string, b: object = {}) => authed('post', p, ownerCookies, ownerCsrf).send(b);
  const ownerPut = (p: string, b: object = {}) => authed('put', p, ownerCookies, ownerCsrf).send(b);
  const ownerGet = (p: string) => authed('get', p, ownerCookies);
  const login = async (e: string, pw: string) => {
    const res = await request(server()).post('/api/v1/auth/login').set('Host', host).send({ email: e, password: pw });
    return res.headers['set-cookie'] as unknown as string[];
  };

  /** A staff profile whose USER sits in `campusId` — the dimension the old scoping keyed on. */
  async function createTeacher(email: string, campusId: string): Promise<string> {
    const res = await ownerPost('/api/v1/staff', {
      email, campusId, staffType: 'TEACHER', employeeCode: `EMP-${randomUUID().slice(0, 6)}`,
      designation: 'Teacher', joinedAt: '2026-04-01', fullName: `T ${email.split('@')[0]}`,
    });
    expect(res.status).toBe(201);
    return res.body.staffId;
  }

  const sectionSubjectIds = async (sectionId: string): Promise<string[]> => {
    const res = await ownerGet(`/api/v1/sections?classId=${classA}`);
    return (res.body as { id: string; subjectIds: string[] }[]).find((s) => s.id === sectionId)?.subjectIds ?? [];
  };

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
      name: 'Structure School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password,
    });
    schoolId = prov.schoolId;
    campusA = prov.campusId;

    ownerCookies = await login(owner.email, owner.password);
    ownerCsrf = csrfOf(ownerCookies);

    // Two NON-OVERLAPPING years; the second is current. The year dimension is the whole point
    // of half this spec, so a single year would make those cases vacuous.
    lastYear = (await ownerPost('/api/v1/academic-years', { name: '2025-26', startDate: '2025-04-01', endDate: '2026-03-31' })).body.id;
    thisYear = (await ownerPost('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true })).body.id;

    campusB = (await ownerPost('/api/v1/campuses', { name: 'Campus B' })).body.id;

    classA = (await ownerPost('/api/v1/classes', { campusId: campusA, name: '9th', order: 9 })).body.id;
    maths = (await ownerPost('/api/v1/subjects', { classId: classA, name: 'Mathematics' })).body.id;
    science = (await ownerPost('/api/v1/subjects', { classId: classA, name: 'Science' })).body.id;
    urdu = (await ownerPost('/api/v1/subjects', { classId: classA, name: 'Urdu' })).body.id;
    // A studies everything the class offers (no explicit list); B opts into a subset.
    sectionA = (await ownerPost('/api/v1/sections', { classId: classA, name: 'A' })).body.id;
    sectionB = (await ownerPost('/api/v1/sections', { classId: classA, name: 'B', subjectIds: [maths, science] })).body.id;

    classOnB = (await ownerPost('/api/v1/classes', { campusId: campusB, name: '9th', order: 9 })).body.id;
    foreignSubject = (await ownerPost('/api/v1/subjects', { classId: classOnB, name: 'Biology' })).body.id;
    sectionOnB = (await ownerPost('/api/v1/sections', { classId: classOnB, name: 'A' })).body.id;

    teacherOnA = await createTeacher('teach.a@cst.pk', campusA);
    teacherOnB = await createTeacher('teach.b@cst.pk', campusB);

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

  // ── A section's own subject list ───────────────────────────────────────────
  describe('PUT /sections/:id/subjects', () => {
    it('REPLACES the set rather than adding to it', async () => {
      expect(await sectionSubjectIds(sectionB)).toHaveLength(2);

      const res = await ownerPut(`/api/v1/sections/${sectionB}/subjects`, { subjectIds: [urdu] });
      expect(res.status).toBe(200);

      // Not [maths, science, urdu] — the operator is stating the whole list, not appending.
      expect(await sectionSubjectIds(sectionB)).toEqual([urdu]);
    });

    it('an empty list means "studies everything the class offers", not "studies nothing"', async () => {
      const res = await ownerPut(`/api/v1/sections/${sectionB}/subjects`, { subjectIds: [] });
      expect(res.status).toBe(200);
      // Zero link rows is the inherit-all signal, which is why no backfill was needed when
      // section_subjects was introduced.
      expect(await sectionSubjectIds(sectionB)).toEqual([]);

      await ownerPut(`/api/v1/sections/${sectionB}/subjects`, { subjectIds: [maths, science] });
    });

    it('refuses a subject belonging to another class (422) and leaves the existing set intact', async () => {
      const res = await ownerPut(`/api/v1/sections/${sectionB}/subjects`, { subjectIds: [maths, foreignSubject] });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      // The rejected write must not have half-applied — the delete runs before the insert.
      expect((await sectionSubjectIds(sectionB)).sort()).toEqual([maths, science].sort());
    });

    it('a campus-bound admin cannot set subjects on another campus’s section (403)', async () => {
      const res = await authed('put', `/api/v1/sections/${sectionOnB}/subjects`, adminCookies, adminCsrf).send({ subjectIds: [] });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('leaves the teacher assignments of surviving subjects untouched', async () => {
      await ownerPut(`/api/v1/sections/${sectionB}/subjects`, { subjectIds: [maths, science] });
      const assign = await ownerPost('/api/v1/teacher-assignments', {
        staffId: teacherOnA, academicYearId: thisYear, sectionId: sectionB, subjectId: maths,
      });
      expect(assign.status).toBe(201);

      // Drop Science; Maths stays on the section.
      await ownerPut(`/api/v1/sections/${sectionB}/subjects`, { subjectIds: [maths] });

      const rows = await ownerGet(`/api/v1/teacher-assignments?sectionId=${sectionB}`);
      expect(rows.body).toHaveLength(1);
      expect(rows.body[0]).toMatchObject({ subjectId: maths, staffId: teacherOnA });

      await authed('delete', `/api/v1/teacher-assignments/${assign.body.id}`, ownerCookies, ownerCsrf);
      await ownerPut(`/api/v1/sections/${sectionB}/subjects`, { subjectIds: [maths, science] });
    });
  });

  // ── Teacher assignments ────────────────────────────────────────────────────
  describe('GET /teacher-assignments', () => {
    it('returns the CURRENT year by default and another only when asked', async () => {
      const old = await ownerPost('/api/v1/teacher-assignments', {
        staffId: teacherOnA, academicYearId: lastYear, sectionId: sectionA, subjectId: maths,
      });
      expect(old.status).toBe(201);

      const current = await ownerGet(`/api/v1/teacher-assignments?sectionId=${sectionA}`);
      expect(current.status).toBe(200);
      expect(current.body).toHaveLength(0); // last year's row must not surface as this year's

      const named = await ownerGet(`/api/v1/teacher-assignments?sectionId=${sectionA}&academicYearId=${lastYear}`);
      expect(named.body).toHaveLength(1);
      expect(named.body[0]).toMatchObject({ academicYearId: lastYear, subjectId: maths });
    });

    it('carries the teacher’s name so a caller need not load the staff directory', async () => {
      const res = await ownerGet(`/api/v1/teacher-assignments?sectionId=${sectionA}&academicYearId=${lastYear}`);
      expect(res.body[0].teacherName).toBe('T teach.a');
    });

    it('assigning this year leaves LAST year’s record intact', async () => {
      // The Classes screen replaces a teacher by delete-then-create. Before the year filter it
      // matched on (section, subject) alone, so "who teaches 9-A Maths this year?" resolved to
      // the historical row and reassignment destroyed the record of who taught it last year.
      // A SECOND teacher of campus A. This used to use `teacherOnB`, which sits in campus B — a
      // cross-campus assignment that stopped being possible on 2026-08-11. The year filter is what
      // this case is about, and it needs two different teachers, not two different campuses.
      const relief = await createTeacher('teach.a2@cst.pk', campusA);
      const fresh = await ownerPost('/api/v1/teacher-assignments', {
        staffId: relief, academicYearId: thisYear, sectionId: sectionA, subjectId: maths,
      });
      expect(fresh.status).toBe(201);

      const lastYearRows = await ownerGet(`/api/v1/teacher-assignments?sectionId=${sectionA}&academicYearId=${lastYear}`);
      expect(lastYearRows.body).toHaveLength(1);
      expect(lastYearRows.body[0].staffId).toBe(teacherOnA);

      const thisYearRows = await ownerGet(`/api/v1/teacher-assignments?sectionId=${sectionA}`);
      expect(thisYearRows.body).toHaveLength(1);
      expect(thisYearRows.body[0].staffId).toBe(relief);
    });

    /**
     * ⚠️ **This case used to assert the opposite, and the change is deliberate.**
     *
     * It read *"a campus admin sees an assignment on their OWN section even when the teacher sits
     * in another campus"* — built when scoping by the *teacher's* campus was hiding rows from the
     * admin who owned the section. That fix was right about the scoping and wrong about the
     * premise: a teacher may no longer be assigned outside their campus at all (operator decision,
     * 2026-08-11), so teacher campus and section campus are now always the same and the two
     * scopings are indistinguishable. The old case can no longer be constructed.
     *
     * What survives is the half that still has meaning: the admin sees their own section's
     * assignment.
     */
    it('a campus admin sees the assignment on their OWN section', async () => {
      const res = await authed('get', `/api/v1/teacher-assignments?sectionId=${sectionA}`, adminCookies);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ sectionId: sectionA });
    });

    it('a campus admin sees nothing on another campus’s section', async () => {
      await ownerPost('/api/v1/teacher-assignments', {
        staffId: teacherOnB, academicYearId: thisYear, sectionId: sectionOnB, subjectId: foreignSubject,
      });
      const res = await authed('get', `/api/v1/teacher-assignments?sectionId=${sectionOnB}`, adminCookies);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });
  });

  describe('POST /teacher-assignments', () => {
    it('refuses to place a teacher in front of another campus’s section (403)', async () => {
      // The staff check alone was not enough: a campus-A admin could take their OWN campus-A
      // teacher and assign them to a campus-B section, because the section was never checked.
      const res = await authed('post', '/api/v1/teacher-assignments', adminCookies, adminCsrf).send({
        staffId: teacherOnA, academicYearId: thisYear, sectionId: sectionOnB, subjectId: foreignSubject,
      });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('allows a campus admin to assign within their own campus', async () => {
      const res = await authed('post', '/api/v1/teacher-assignments', adminCookies, adminCsrf).send({
        staffId: teacherOnA, academicYearId: thisYear, sectionId: sectionA, subjectId: science,
      });
      expect(res.status).toBe(201);
    });
  });
});
