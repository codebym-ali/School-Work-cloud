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
 * The admission checklist, the photograph and the parent declaration (Admission Field Gaps, Tier 3).
 *
 * ⚠️ Two of these pin bug CLASSES this codebase has actually shipped:
 *  - Tier 1 added record fields to the DTO but not to the write, so PATCH returned 200 and changed
 *    nothing. Every new field here is read back after writing.
 *  - A route stricter than the job has silently DELETED capability three times (CSV import,
 *    /my-attendance, /my-leaves). The ADMISSION_CONTROLLER — the role that actually receives
 *    paperwork — is asserted to reach both checklist routes.
 */
describe('Student documents, photo & declaration (e2e)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let campusId: string;
  let classId: string;
  let sectionId: string;
  let admit: (dto: object) => request.Test;
  let acCookies: string[];
  let studentId: string;

  const sub = `sdoc-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@sdoc.pk', password: 'Owner!Secret12' };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send(b);
  const get = (p: string, c: string[] = cookies) => request(server()).get(p).set('Host', host).set('Cookie', c);
  const patch = (p: string, b: object) =>
    request(server()).patch(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send(b);
  const put = (p: string, b: object, c: string[] = cookies) =>
    request(server()).put(p).set('Host', host).set('Cookie', c).set('X-CSRF-Token', csrfOf(c)).send(b);

  type ChecklistRow = { type: string; label: string; mandatory: boolean; received: boolean; receivedAt: string | null; fileKey: string | null; note: string | null };
  const typed = (body: ChecklistRow[], type: string) => body.find((d) => d.type === type)!;

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
      name: 'SDoc School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password,
    });
    schoolId = prov.schoolId;
    campusId = prov.campusId;

    cookies = (await loginRequest(server(), host, owner.email, owner.password)).headers['set-cookie'] as unknown as string[];
    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    classId = (await post('/api/v1/classes', { campusId, name: 'Grade 1', order: 1 })).body.id;
    sectionId = (await post('/api/v1/sections', { classId, name: 'A' })).body.id;

    ({ admit, cookies: acCookies } = await admissionController(app, platform, schoolId, host, campusId));
    const created = await admit({
      fullName: 'Documents Child', gender: 'FEMALE', dateOfBirth: '2019-05-02',
      campusId, classId, sectionId, rollNumber: 1,
      guardian: { mode: 'CREATE', fullName: 'Doc Parent', phone: '03120000001', relation: 'FATHER' },
    });
    expect(created.status).toBe(201);
    // ⚠️ `studentId`, not `id`: createStudent returns the admission result
    // ({ studentId, enrollmentId, grNumber, registrationNo, rollNumber }), not the student row.
    studentId = created.body.studentId;
    expect(studentId).toBeTruthy();
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('lists EVERY document type, not only the ones already recorded', async () => {
    // A checklist showing only what has been ticked cannot show what is OUTSTANDING — which is the
    // only question it exists to answer.
    const res = await get(`/api/v1/students/${studentId}/documents`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(8);
    expect(typed(res.body, 'B_FORM')).toMatchObject({ label: 'B-Form', mandatory: true, received: false, fileKey: null });
    // Applies to TRANSFERS only; a child starting in KG has none, so it must never block.
    expect(typed(res.body, 'PREV_SCHOOL_LEAVING').mandatory).toBe(false);
  });

  it('records a document WITHOUT a file — the counter case', async () => {
    // These arrive as photocopies far more often than as scans. Requiring an upload to tick the box
    // would push the office into ticking things that are not true.
    const res = await put(`/api/v1/students/${studentId}/documents/B_FORM`, { received: true, note: 'photocopy taken at counter' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: 'B_FORM', received: true, fileKey: null, note: 'photocopy taken at counter' });
    expect(res.body.receivedAt).toBeTruthy();
  });

  it('does not rewrite receivedAt when the row is saved again', async () => {
    // The date the school took delivery is a fact about the past; editing a note must not move it.
    const before = typed((await get(`/api/v1/students/${studentId}/documents`)).body, 'B_FORM').receivedAt;
    const again = await put(`/api/v1/students/${studentId}/documents/B_FORM`, { received: true, note: 'note edited' });
    expect(again.body.receivedAt).toBe(before);
  });

  it('clears receivedAt when a document is un-ticked', async () => {
    const cleared = await put(`/api/v1/students/${studentId}/documents/PREV_REPORT_CARD`, { received: false });
    expect(cleared.body).toMatchObject({ received: false, receivedAt: null });
  });

  it('lets the ADMISSION_CONTROLLER read and record — the role that handles paperwork', async () => {
    expect((await get(`/api/v1/students/${studentId}/documents`, acCookies)).status).toBe(200);
    const wrote = await put(`/api/v1/students/${studentId}/documents/GUARDIAN_CNIC`, { received: true }, acCookies);
    expect(wrote.status).toBe(200);
    expect(wrote.body.received).toBe(true);
  });

  it('keeps the checklist OUT of recordComplete, and reports it separately', async () => {
    // ⚠️ Folding documents into `recordComplete` was tried and reverted. It silently redefines what
    // "complete" has always meant — three older specs assert the chase list empties once the TEXT
    // fields are filled — and on a live school it would mark every already-admitted student
    // incomplete overnight. A list nobody can empty is a list nobody reads.
    await patch(`/api/v1/students/${studentId}`, {
      religion: 'Islam', addressLine: '12 Mall Road', city: 'Lahore',
      emergencyName: 'Doc Parent', emergencyPhone: '03120000001',
    });
    expect((await get(`/api/v1/students/${studentId}`)).body.missingFields).toEqual([]);

    // The documents signal is separate, and it is NOT satisfied yet: B_FORM is recorded but the
    // guardian CNIC was ticked by the admission controller above, so both mandatory ones are in.
    const listed = await get(`/api/v1/students?search=Documents`);
    const row = listed.body.data.find((r: { id: string }) => r.id === studentId);
    expect(row.recordComplete).toBe(true);
    expect(row.documentsComplete).toBe(true);
  });

  it('reports documentsComplete false while a mandatory document is outstanding', async () => {
    await put(`/api/v1/students/${studentId}/documents/B_FORM`, { received: false });
    const listed = await get(`/api/v1/students?search=Documents`);
    const row = listed.body.data.find((r: { id: string }) => r.id === studentId);
    // The record is still "complete" — the distinction is the point.
    expect(row.recordComplete).toBe(true);
    expect(row.documentsComplete).toBe(false);
    await put(`/api/v1/students/${studentId}/documents/B_FORM`, { received: true });
  });

  it('persists the photograph key — the column existed with nothing writing to it', async () => {
    // Tier 1 shipped fields the DTO accepted and the write silently dropped: 200, and no change.
    const key = 'uploads/school/abc-photo.png';
    expect((await patch(`/api/v1/students/${studentId}`, { photoKey: key })).status).toBe(200);
    expect((await get(`/api/v1/students/${studentId}`)).body.photoKey).toBe(key);
  });

  it('stamps the declaration server-side and keeps the version agreed to', async () => {
    const res = await patch(`/api/v1/students/${studentId}`, {
      declarationVersion: 'admission-terms-v2',
      declarationAcceptedBy: 'Doc Parent',
    });
    expect(res.status).toBe(200);
    const body = (await get(`/api/v1/students/${studentId}`)).body;
    expect(body.declarationVersion).toBe('admission-terms-v2');
    expect(body.declarationAcceptedBy).toBe('Doc Parent');
    // ⚠️ Server-stamped: a client-supplied date on a legal record is a date the client can choose.
    expect(body.declarationAcceptedAt).toBeTruthy();
  });

  it('rejects an unknown document type rather than inventing a row', async () => {
    const res = await put(`/api/v1/students/${studentId}/documents/NOT_A_DOCUMENT`, { received: true });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
