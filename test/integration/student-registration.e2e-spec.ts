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

/**
 * Student registration number + manual roll number. Proves: registration number is
 * auto-assigned, sequential and gap-free per school; the manual roll persists; a duplicate
 * roll in the same section/year is rejected; and both IDs show on the profile (GET :id).
 */
describe('Student registration & roll (e2e)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let campusId: string;
  let classId: string;
  let sectionId: string;
  let admit: (dto: object) => request.Test;

  const sub = `sreg-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@sreg.pk', password: 'Owner!Secret12' };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send(b);
  const get = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

  const student = (name: string, roll: number, phone: string) => ({
    fullName: name, gender: 'MALE', dateOfBirth: '2013-04-01', campusId, classId, sectionId, rollNumber: roll,
    guardian: { mode: 'CREATE', fullName: `${name} Parent`, phone, relation: 'FATHER' },
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const provisioning = app.get(ProvisioningService, { strict: false });
    const prov = await provisioning.provisionSchool({ name: 'SReg School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;
    campusId = prov.campusId;

    const login = await loginRequest(server(), host, owner.email, owner.password);
    cookies = login.headers['set-cookie'] as unknown as string[];

    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    const klass = await post('/api/v1/classes', { campusId, name: 'Grade 9', order: 9 });
    classId = klass.body.id;
    sectionId = (await post('/api/v1/sections', { classId, name: 'A' })).body.id;

    // Students are created by the admission controller (not owner) under the §8 rule.
    ({ admit } = await admissionController(app, platform, schoolId, host, campusId));
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('auto-assigns a sequential, gap-free registration number and persists the manual roll', async () => {
    const a = await admit(student('Alpha', 1, '03110000001'));
    expect(a.status).toBe(201);
    expect(a.body.registrationNo).toBeTruthy();
    expect(a.body.rollNumber).toBe(1);
    expect(a.body.grNumber).toBeTruthy();

    const b = await admit(student('Bravo', 2, '03110000002'));
    expect(b.status).toBe(201);
    // Sequential + gap-free: the second registration number is the first + 1.
    expect(Number(b.body.registrationNo)).toBe(Number(a.body.registrationNo) + 1);
    expect(b.body.rollNumber).toBe(2);
  });

  it('rejects a duplicate roll number in the same section/year → 409 ROLL_NUMBER_TAKEN', async () => {
    const dup = await admit(student('Charlie', 1, '03110000003'));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('ROLL_NUMBER_TAKEN');
  });

  /**
   * The office-set joining date (Admission Form Field Gaps, Tier 1).
   *
   * ⚠️ **This is money, not metadata.** A back-dated admission is routine — the child started on
   * the 1st, the office keyed it in on the 5th — and the enrolment's `startedAt` is what fee
   * proration and seniority read. Before this it was always `now()`, so every back-dated admission
   * silently billed from the wrong day with nothing downstream able to tell.
   */
  it('records a back-dated joining date on the enrolment', async () => {
    const created = await admit({ ...student('Echo', 4, '03110000005'), admissionDate: '2026-05-10' });
    expect(created.status).toBe(201);

    const profile = await get(`/api/v1/students/${created.body.studentId}`);
    expect(profile.status).toBe(200);
    expect(String(profile.body.enrollments[0].startedAt).slice(0, 10)).toBe('2026-05-10');
  });

  it('defaults to today when the form does not send one', async () => {
    // Keeps every existing caller unchanged — CSV import and the pipeline admit send nothing.
    const created = await admit(student('Foxtrot', 5, '03110000006'));
    expect(created.status).toBe(201);

    const profile = await get(`/api/v1/students/${created.body.studentId}`);
    const today = new Date().toISOString().slice(0, 10);
    expect(String(profile.body.enrollments[0].startedAt).slice(0, 10)).toBe(today);
  });

  it('refuses a FUTURE joining date rather than clamping it → 422', async () => {
    // ⚠️ Refused, not silently moved to today: a future start would open a register the student
    // cannot be marked on and bill from a day that has not happened. Clamping would hide the
    // keying error until it surfaced as a wrong invoice weeks later.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const res = await admit({ ...student('Golf', 6, '03110000007'), admissionDate: tomorrow });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/future/i);
  });

  /**
   * Father AND Mother in one admission (Tier 1) — the normal case in a Pakistani school.
   *
   * ⚠️ The many-guardian SHAPE was already modelled (`student_guardians`); what was missing was a
   * way to send more than one at admission. The first is the primary: every SMS dispatch and fee
   * receipt resolves the primary guardian, so the order the form sends is load-bearing.
   */
  it('records both parents, with the first as the primary guardian', async () => {
    const created = await admit({
      fullName: 'Hotel', gender: 'MALE', dateOfBirth: '2013-04-01', campusId, classId, sectionId, rollNumber: 7,
      religion: 'Islam', addressLine: 'House 12, Street 4', city: 'Lahore',
      emergencyName: 'Uncle Kamal', emergencyPhone: '03110000099', emergencyRelation: 'Uncle',
      guardians: [
        { mode: 'CREATE', fullName: 'Hotel Father', phone: '03110000008', relation: 'FATHER', occupation: 'Shopkeeper' },
        { mode: 'CREATE', fullName: 'Hotel Mother', phone: '03110000009', relation: 'MOTHER' },
      ],
    });
    expect(created.status).toBe(201);

    const profile = await get(`/api/v1/students/${created.body.studentId}`);
    expect(profile.status).toBe(200);
    expect(profile.body.guardians).toHaveLength(2);

    const primary = profile.body.guardians.filter((g: { isPrimary: boolean }) => g.isPrimary);
    expect(primary).toHaveLength(1);
    expect(primary[0].relation).toBe('FATHER');
    expect(primary[0].parent.fullName).toBe('Hotel Father');

    // The admission-record fields land on the student, not just in the request.
    expect(profile.body.religion).toBe('Islam');
    expect(profile.body.addressLine).toBe('House 12, Street 4');
    expect(profile.body.city).toBe('Lahore');
    expect(profile.body.emergencyName).toBe('Uncle Kamal');
    expect(profile.body.emergencyRelation).toBe('Uncle');
  });

  it('still admits with no guardian at all — the walk-in path is untouched', async () => {
    // The whole reason `guardian` was optional: a child can be seated now and the parents chased
    // later. Making Father+Mother possible must not quietly make either of them required.
    const created = await admit({
      fullName: 'India', gender: 'FEMALE', dateOfBirth: '2013-04-01', campusId, classId, sectionId, rollNumber: 8,
    });
    expect(created.status).toBe(201);

    const profile = await get(`/api/v1/students/${created.body.studentId}`);
    expect(profile.body.guardians).toHaveLength(0);
    expect(profile.body.religion).toBeNull();
  });

  it('refuses the same parent twice rather than writing two rows → 409', async () => {
    // A form that sends one person as both Father and Guardian is a keying error, and the join is
    // unique on (student, parent) — so it must fail loudly rather than half-succeed.
    const res = await admit({
      fullName: 'Juliet', gender: 'MALE', dateOfBirth: '2013-04-01', campusId, classId, sectionId, rollNumber: 9,
      guardians: [
        { mode: 'CREATE', fullName: 'Juliet Father', phone: '03110000010', relation: 'FATHER' },
        { mode: 'CREATE', fullName: 'Juliet Father again', phone: '03110000010', relation: 'GUARDIAN' },
      ],
    });
    expect(res.status).toBe(409);
  });

  it('shows the registration number, GR, and roll on the student profile (GET :id)', async () => {
    const created = await admit(student('Delta', 3, '03110000004'));
    const profile = await get(`/api/v1/students/${created.body.studentId}`);
    expect(profile.status).toBe(200);
    expect(profile.body.registrationNo).toBe(created.body.registrationNo);
    expect(profile.body.grNumber).toBe(created.body.grNumber);
    expect(profile.body.enrollments[0].rollNumber).toBe(3);
  });
});
