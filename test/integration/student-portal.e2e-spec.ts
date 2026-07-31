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
  let grNumber: string;

  const sub = `sp-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@sp.pk', password: 'Owner!Secret12' };
  const studentLogin = { email: 'kid@sp.pk', password: 'Student!Secret12' };

  const server = () => app.getHttpServer();
  const login = async (email: string, password: string) => {
    const res = await request(server()).post('/api/v1/auth/login').set('Host', host).send({ email, password });
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
    await ownerPost('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    const klass = await ownerPost('/api/v1/classes', { campusId: prov.campusId, name: 'Grade 1', order: 1 });
    const section = await ownerPost('/api/v1/sections', { classId: klass.body.id, name: 'A' });
    const { admit } = await admissionController(app, platform, schoolId, host, prov.campusId);
    const student = await admit({
      fullName: 'Kid One', gender: 'MALE', dateOfBirth: '2015-05-10', campusId: prov.campusId, classId: klass.body.id, sectionId: section.body.id,
      guardian: { mode: 'CREATE', fullName: 'Papa', phone: '03007654321', relation: 'FATHER' },
    });
    grNumber = student.body.grNumber;

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

  it('denies a non-student (owner) the portal (403)', async () => {
    expect((await get('/api/v1/portal/overview', ownerCookies)).status).toBe(403);
  });
});
