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

    const login = await request(server())
      .post('/api/v1/auth/login')
      .set('Host', host)
      .send({ email: ownerEmail, password: ownerPassword });
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
});
