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
import { opsAdminSession } from './support/ops-admin';

/**
 * The owner's attendance overview (Owner UX Phase 1c). It is read-only oversight, so what matters is that
 * it tells the truth: the right person named for a register, closed days shown as closed (not as gaps),
 * "present" over the records that exist, and a child absent three school days running actually surfaced.
 */
describe('Attendance overview (e2e, Owner UX 1c)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let classId: string;
  let sectionA: string;
  let sectionB: string;
  const enrol: Record<string, string> = {};
  let ops: Awaited<ReturnType<typeof opsAdminSession>>;

  const sub = `aov-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@aov.pk', password: 'Owner!Secret12' };
  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send(b);
  const get = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  /** The last `n` school days BEFORE today (the default weekly off is Sunday), oldest first. */
  function pastSchoolDays(n: number): string[] {
    const out: string[] = [];
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    while (out.length < n) {
      d.setUTCDate(d.getUTCDate() - 1);
      if (d.getUTCDay() !== 0) out.unshift(iso(d));
    }
    return out;
  }
  const days = pastSchoolDays(3);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const provisioning = app.get(ProvisioningService, { strict: false });
    const prov = await provisioning.provisionSchool({ name: 'AOV School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;
    const campusId = prov.campusId;
    cookies = (await loginRequest(server(), host, owner.email, owner.password)).headers['set-cookie'] as unknown as string[];

    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    classId = (await post('/api/v1/classes', { campusId, name: 'Grade 5', order: 5 })).body.id;
    sectionA = (await post('/api/v1/sections', { classId, name: 'A' })).body.id;
    sectionB = (await post('/api/v1/sections', { classId, name: 'B' })).body.id;

    // A homeroom teacher for A only — B must read "no class teacher", not borrow A's.
    const staff = (await post('/api/v1/staff', {
      email: 't@aov.pk', staffType: 'TEACHER', employeeCode: 'EMP-T1', designation: 'Teacher', joinedAt: '2026-04-01', campusId, fullName: 'Nadia Khan',
    })).body;
    const year = await platform.academicYear.findFirst({ where: { schoolId, isCurrent: true } });
    expect((await post('/api/v1/teacher-assignments', { staffId: staff.staffId, academicYearId: year!.id, sectionId: sectionA })).status).toBe(201);

    const { admit } = await admissionController(app, platform, schoolId, host, campusId);
    const joined = iso(new Date(Date.now() - 30 * 86400000));
    for (const [name, sectionId] of [['Ali', sectionA], ['Bina', sectionA], ['Chand', sectionB]] as const) {
      const res = await admit({ fullName: name, gender: 'MALE', dateOfBirth: '2015-01-01', campusId, classId, sectionId, admissionDate: joined });
      expect(res.status).toBe(201);
      enrol[name] = res.body.enrollmentId;
    }

    // The office marks (the owner cannot): Ali absent three school days running, Bina present throughout.
    ops = await opsAdminSession(app, platform, schoolId, host);
    for (const date of days) {
      const res = await ops.post('/api/v1/attendance/bulk', {
        sectionId: sectionA, date, session: 'MORNING', allowHolidayOverride: true,
        records: [{ enrollmentId: enrol.Ali, status: 'ABSENT' }, { enrollmentId: enrol.Bina, status: 'PRESENT' }],
      });
      expect(res.body.failed).toBe(0);
    }
  });

  // No SMS queue to drain: every absence here is on a PAST date, which the register records without
  // texting parents.
  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('names the class teacher per register, and says so when there is none', async () => {
    const res = await get('/api/v1/attendance/overview');
    expect(res.status).toBe(200);
    const a = res.body.sections.find((s: { sectionId: string }) => s.sectionId === sectionA);
    const b = res.body.sections.find((s: { sectionId: string }) => s.sectionId === sectionB);
    expect(a.teacher).toBe('Nadia Khan');
    expect(b.teacher).toBeNull();
    expect(a.expected).toBe(2);
  });

  it('computes each marked day over the records that exist, and leaves unmarked days empty', async () => {
    const a = (await get('/api/v1/attendance/overview')).body.sections.find((s: { sectionId: string }) => s.sectionId === sectionA);
    for (const date of days) {
      const cell = a.cells.find((c: { date: string }) => c.date === date);
      expect(cell).toMatchObject({ marked: 2, present: 1, percent: 50, closed: null });
    }
    expect(a.periodPercent).toBe(50);
    const b = (await get('/api/v1/attendance/overview')).body.sections.find((s: { sectionId: string }) => s.sectionId === sectionB);
    expect(b.cells.every((c: { marked: number; percent: number | null }) => c.marked === 0 && c.percent === null)).toBe(true);
  });

  it('shows a Sunday as closed, never as a gap', async () => {
    const a = (await get('/api/v1/attendance/overview')).body.sections.find((s: { sectionId: string }) => s.sectionId === sectionA);
    const sunday = a.cells.find((c: { date: string }) => new Date(`${c.date}T00:00:00Z`).getUTCDay() === 0);
    expect(sunday.closed).toBe('Weekly off');
  });

  it('surfaces a child absent three school days running — and nobody else', async () => {
    const res = await get('/api/v1/attendance/overview');
    expect(res.body.chronic).toHaveLength(1);
    expect(res.body.chronic[0]).toMatchObject({ fullName: 'Ali', days: 3, sectionId: sectionA, since: days[0] });
    expect(res.body.belowThreshold).toContain(sectionA);
  });

  it('narrows to a section', async () => {
    const res = await get(`/api/v1/attendance/overview?sectionId=${sectionB}`);
    expect(res.body.sections.map((s: { sectionId: string }) => s.sectionId)).toEqual([sectionB]);
    expect(res.body.chronic).toHaveLength(0);
  });

  it('is readable by the owner, but the owner still cannot mark', async () => {
    const mark = await post('/api/v1/attendance/bulk', {
      sectionId: sectionB, date: days[2], session: 'MORNING', records: [{ enrollmentId: enrol.Chand, status: 'PRESENT' }],
    });
    expect(mark.status).toBe(403);
  });
});
