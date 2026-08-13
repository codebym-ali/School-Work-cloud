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
 * Bulk student CSV import (§22.6). Verifies: the file is validated as a whole (bad rows
 * reported, nothing written), a clean file imports all-or-nothing, and siblings sharing a
 * guardian phone are linked to ONE parent (not duplicated).
 */
describe('Students CSV import (e2e, §22.6)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let csrf: string;
  let importCsv: (b: object) => request.Test;

  const sub = `imp-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const email = 'owner@imp.pk';
  const password = 'Owner!Secret12';
  const HEADER = 'fullName,gender,dateOfBirth,className,sectionName,guardianName,guardianPhone,relation';

  const server = () => app.getHttpServer();
  const post = (p: string, b: object = {}) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).send(b);
  const get = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const provisioning = app.get(ProvisioningService, { strict: false });
    const prov = await provisioning.provisionSchool({ name: 'Import School', subdomain: sub, ownerEmail: email, ownerPassword: password });
    schoolId = prov.schoolId;

    const login = await loginRequest(server(), host, email, password);
    cookies = login.headers['set-cookie'] as unknown as string[];
    csrf = (cookies.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);

    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    const klass = await post('/api/v1/classes', { campusId: prov.campusId, name: 'Grade 1', order: 1 });
    await post('/api/v1/sections', { classId: klass.body.id, name: 'A' });

    // Import is admission-controller-only (§8) → run it as the AC, not the owner.
    const ac = await admissionController(app, platform, schoolId, host, prov.campusId);
    importCsv = (b: object) =>
      request(server()).post('/api/v1/students/import').set('Host', host).set('Cookie', ac.cookies).set('X-CSRF-Token', ac.csrf).send(b);
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('reports per-row errors and imports NOTHING when the file has bad rows (dryRun)', async () => {
    const csv = [
      HEADER,
      'Ali Raza,MALE,2016-03-01,Grade 1,A,Bilal Raza,03001112233,FATHER', // good
      'Bad Gender,MARTIAN,2016-03-01,Grade 1,A,X,03001112244,FATHER', // bad gender
      'No Section,MALE,2016-03-01,Grade 1,Z,Y,03001112255,FATHER', // unknown section
    ].join('\n');

    const res = await importCsv({ csv, dryRun: true });
    expect(res.status).toBe(201);
    expect(res.body.imported).toBe(0);
    expect(res.body.failed).toBe(2);
    const fields = res.body.errors.map((e: { field: string }) => e.field);
    expect(fields).toContain('gender');
    expect(fields).toContain('sectionName');
    // Nothing written.
    expect(await platform.student.count({ where: { schoolId } })).toBe(0);
  });

  it('imports a clean file all-or-nothing and links siblings to ONE guardian', async () => {
    const csv = [
      HEADER,
      'Ahmed Khan,MALE,2015-06-10,Grade 1,A,Kamran Khan,03009998877,FATHER',
      'Ayesha Khan,FEMALE,2017-06-10,Grade 1,A,Kamran Khan,03009998877,FATHER', // same guardian phone → sibling
    ].join('\n');

    const res = await importCsv({ csv });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ imported: 2, failed: 0, dryRun: false });
    expect(res.body.errors).toHaveLength(0);
    expect(res.body.students).toHaveLength(2);
    expect(res.body.students[0].grNumber).toBeTruthy();

    // Both students exist with an ACTIVE enrollment.
    expect(await platform.student.count({ where: { schoolId } })).toBe(2);
    expect(await platform.studentEnrollment.count({ where: { schoolId, status: 'ACTIVE' } })).toBe(2);
    // Siblings share ONE parent (not two Kamran Khans).
    expect(await platform.parentProfile.count({ where: { schoolId, fullName: 'Kamran Khan' } })).toBe(1);

    // The two students are searchable in the directory.
    const list = await get('/api/v1/students?search=Khan');
    expect(list.body.total).toBe(2);
  });

  it('rejects a CSV missing a required column (422)', async () => {
    const csv = ['fullName,gender,dateOfBirth,className,sectionName', 'X,MALE,2016-03-01,Grade 1,A'].join('\n');
    const res = await importCsv({ csv });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/missing required column/i);
  });
});
