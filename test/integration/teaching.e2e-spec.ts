import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { admissionController } from './support/admission';

/**
 * Teacher self-service ("my classes" + rosters, §9/§11). A teacher sees only the sections
 * they hold a TeacherAssignment for, with a live active-student count, and can read the
 * roster of an assigned section but is 403'd on a section they aren't assigned to (§22.8).
 */
describe('Teaching self-service (e2e)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;

  let ownerCookies: string[];
  let ownerCsrf: string;
  let teacherCookies: string[];

  let sectionId: string; // teacher IS assigned here
  let otherSectionId: string; // teacher is NOT assigned here

  const sub = `tea-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@tea.pk', password: 'Owner!Secret12' };
  const teacher = { email: 'teacher@tea.pk', password: 'Teacher!Secret12' };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const login = async (e: string, pw: string) => {
    const res = await request(server()).post('/api/v1/auth/login').set('Host', host).send({ email: e, password: pw });
    return res.headers['set-cookie'] as unknown as string[];
  };
  const ownerPost = (p: string, b: object = {}) =>
    request(server()).post(p).set('Host', host).set('Cookie', ownerCookies).set('X-CSRF-Token', ownerCsrf).send(b);
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
    const prov = await provisioning.provisionSchool({ name: 'Tea School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;
    const campusId = prov.campusId;

    ownerCookies = await login(owner.email, owner.password);
    ownerCsrf = csrfOf(ownerCookies);

    const yearId = (await ownerPost('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true })).body.id;
    const classId = (await ownerPost('/api/v1/classes', { campusId, name: 'Grade 5', order: 5 })).body.id;
    sectionId = (await ownerPost('/api/v1/sections', { classId, name: 'A' })).body.id;
    otherSectionId = (await ownerPost('/api/v1/sections', { classId, name: 'B' })).body.id;
    const subjectId = (await ownerPost('/api/v1/subjects', { classId, name: 'Mathematics' })).body.id;

    // Two students enrolled in section A (the teacher's roster) — created by the admission controller (§8).
    const { admit } = await admissionController(app, platform, schoolId, host);
    const mkStudent = async (name: string, phone: string) =>
      admit({
        fullName: name, gender: 'MALE', dateOfBirth: '2015-01-10', campusId, classId, sectionId,
        guardian: { mode: 'CREATE', fullName: `G ${name}`, phone, relation: 'FATHER' },
      });
    await mkStudent('Pupil One', '03001110001');
    await mkStudent('Pupil Two', '03002220002');

    // Create the teacher's staff profile, activate the login, and assign them to section A / Maths.
    const staff = (await ownerPost('/api/v1/staff', {
      email: teacher.email, staffType: 'TEACHER', employeeCode: `EMP-${randomUUID().slice(0, 6)}`,
      designation: 'Maths Teacher', joinedAt: '2026-04-01',
    })).body;
    await platform.user.update({
      where: { id: staff.userId },
      data: { status: 'ACTIVE', passwordHash: await argon2.hash(teacher.password, { type: argon2.argon2id }) },
    });
    await ownerPost('/api/v1/teacher-assignments', { staffId: staff.staffId, academicYearId: yearId, sectionId, subjectId });

    teacherCookies = await login(teacher.email, teacher.password);
  });

  afterAll(async () => {
    const tables = [
      'auditLog', 'teacherAssignment', 'attendanceRecord', 'studentGuardian', 'studentEnrollment', 'student',
      'parentProfile', 'salaryStructure', 'staffProfile', 'subject', 'section', 'class', 'academicYear',
      'refreshToken', 'user', 'campus', 'smsTemplate', 'smsCreditLedger', 'school',
    ] as const;
    for (const t of tables) {
      const d = platform[t] as unknown as { deleteMany: (a: unknown) => Promise<unknown> };
      await d.deleteMany({ where: t === 'school' ? { id: schoolId } : { schoolId } }).catch(() => undefined);
    }
    await app.close();
  });

  it('my-classes returns only the teacher’s assigned section with a live student count', async () => {
    const res = await get('/api/v1/teaching/my-classes', teacherCookies);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ sectionId, className: 'Grade 5', sectionName: 'A', subjectName: 'Mathematics', studentCount: 2 });
  });

  it('roster of an assigned section returns its active students', async () => {
    const res = await get(`/api/v1/teaching/sections/${sectionId}/roster`, teacherCookies);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({ fullName: expect.any(String), grNumber: expect.any(String) });
  });

  it('roster of a section the teacher is NOT assigned to is denied (403)', async () => {
    const res = await get(`/api/v1/teaching/sections/${otherSectionId}/roster`, teacherCookies);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
