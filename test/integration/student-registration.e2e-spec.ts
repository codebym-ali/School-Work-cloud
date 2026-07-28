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

    const login = await request(server()).post('/api/v1/auth/login').set('Host', host).send(owner);
    cookies = login.headers['set-cookie'] as unknown as string[];

    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    const klass = await post('/api/v1/classes', { campusId, name: 'Grade 9', order: 9 });
    classId = klass.body.id;
    sectionId = (await post('/api/v1/sections', { classId, name: 'A' })).body.id;

    // Students are created by the admission controller (not owner) under the §8 rule.
    ({ admit } = await admissionController(app, platform, schoolId, host));
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

  it('shows the registration number, GR, and roll on the student profile (GET :id)', async () => {
    const created = await admit(student('Delta', 3, '03110000004'));
    const profile = await get(`/api/v1/students/${created.body.studentId}`);
    expect(profile.status).toBe(200);
    expect(profile.body.registrationNo).toBe(created.body.registrationNo);
    expect(profile.body.grNumber).toBe(created.body.grNumber);
    expect(profile.body.enrollments[0].rollNumber).toBe(3);
  });
});
