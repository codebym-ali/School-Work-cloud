import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { admissionController } from './support/admission';
import { SMS_QUEUE } from '../../apps/api/src/modules/comms/sms/sms.types';
import { destroyTenant } from './support/tenant';
import { loginRequest } from './support/login';

/**
 * Real PDFs + storage + upload pipeline (blueprint §22.6, §11, §15) against MinIO.
 * Generates a report-card PDF, uploads it, fetches it back via a presigned GET, and
 * exercises the presigned-PUT upload pipeline incl. magic-byte rejection.
 */
describe('Storage, PDFs & uploads (e2e, §22.6)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let csrf: string;
  let studentId: string;

  const sub = `st-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const email = 'owner@st.pk';
  const password = 'Owner!Secret12';

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object = {}) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).send(b);
  const put = (p: string, b: object) =>
    request(server()).put(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).send(b);
  const get = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const prov = await app.get(ProvisioningService, { strict: false }).provisionSchool({ name: 'Storage School', subdomain: sub, ownerEmail: email, ownerPassword: password });
    schoolId = prov.schoolId;
    const login = await loginRequest(server(), host, email, password);
    cookies = login.headers['set-cookie'] as unknown as string[];
    csrf = csrfOf(cookies);

    const yearId = (await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true })).body.id;
    const classId = (await post('/api/v1/classes', { campusId: prov.campusId, name: 'Grade 1', order: 1 })).body.id;
    const sectionId = (await post('/api/v1/sections', { classId, name: 'A' })).body.id;
    const mathId = (await post('/api/v1/subjects', { classId, name: 'Math' })).body.id;
    const { admit } = await admissionController(app, platform, schoolId, host, prov.campusId);
    studentId = (await admit({
      fullName: 'Sara Khan', gender: 'FEMALE', dateOfBirth: '2020-05-10', campusId: prov.campusId, classId, sectionId,
      guardian: { mode: 'CREATE', fullName: 'Ali Khan', phone: '03007654321', relation: 'FATHER' },
    })).body.studentId;
    const enrollmentId = (await get(`/api/v1/enrollments?studentId=${studentId}`)).body.data[0].id;

    await put('/api/v1/grade-scales', { academicYearId: yearId, bands: [{ label: 'A', minPercent: 80, maxPercent: 100, gradePoint: 4 }, { label: 'F', minPercent: 0, maxPercent: 79.99, gradePoint: 0 }] });
    const termId = (await post('/api/v1/terms', { academicYearId: yearId, name: 'Term 1', startDate: '2026-04-01', endDate: '2026-09-30' })).body.id;
    const examId = (await post('/api/v1/exams', { termId, classId, name: 'Final', examType: 'FINAL', weightagePercent: 100, examDate: '2026-07-01' })).body.id;
    await post(`/api/v1/exams/${examId}/open-marks-entry`);
    await post(`/api/v1/exams/${examId}/results/bulk`, { records: [{ enrollmentId, subjectId: mathId, totalMarks: 100, marksObtained: 90 }] });
    await post(`/api/v1/exams/${examId}/publish`);
    await post(`/api/v1/terms/${termId}/report-cards/generate`);
  });

  afterAll(async () => {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('renders a report-card PDF and serves it via a presigned GET', async () => {
    const docs = await get(`/api/v1/documents?studentId=${studentId}`);
    const reportDoc = docs.body.find((d: { type: string }) => d.type === 'REPORT_CARD');
    expect(reportDoc).toBeTruthy();

    const signed = await get(`/api/v1/documents/${reportDoc.id}/url`);
    expect(signed.body.url).toContain('http');

    const fetched = await fetch(signed.body.url);
    expect(fetched.status).toBe(200);
    const buf = Buffer.from(await fetched.arrayBuffer());
    expect(buf.subarray(0, 4).toString('latin1')).toBe('%PDF'); // real PDF bytes
  });

  it('runs the upload pipeline: presigned PUT → confirm → moved to permanent', async () => {
    const req = await post('/api/v1/uploads', { filename: 'photo.pdf', mimeType: 'application/pdf' });
    expect(req.body.key).toContain('quarantine/');

    // Upload a minimal valid PDF directly to the presigned URL.
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    const uploaded = await fetch(req.body.url, { method: 'PUT', body: pdf, headers: { 'Content-Type': 'application/pdf' } });
    expect(uploaded.status).toBe(200);

    const confirmed = await post('/api/v1/uploads/confirm', { key: req.body.key, mimeType: 'application/pdf' });
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.fileKey).toContain('uploads/');
  });

  it('rejects an upload whose content does not match its declared type (422)', async () => {
    const req = await post('/api/v1/uploads', { filename: 'fake.pdf', mimeType: 'application/pdf' });
    await fetch(req.body.url, { method: 'PUT', body: Buffer.from('not a pdf at all'), headers: { 'Content-Type': 'application/pdf' } });
    const confirmed = await post('/api/v1/uploads/confirm', { key: req.body.key, mimeType: 'application/pdf' });
    expect(confirmed.status).toBe(422);
  });
});
