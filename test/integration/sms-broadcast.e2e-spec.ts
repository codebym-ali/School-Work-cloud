import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { SMS_QUEUE } from '../../apps/api/src/modules/comms/sms/sms.types';
import { admissionController } from './support/admission';
import { destroyTenant } from './support/tenant';
import { drainSmsFor } from './support/sms';
import { loginRequest } from './support/login';

/**
 * Broadcast SMS to families (GAP-15).
 *
 * The only way to text a class was `POST /sms/send` with phone numbers typed by hand. These cases pin the
 * audience-based broadcast: the server picks the families, texts each phone once, never texts a parent who
 * opted out, keeps a campus admin inside their campus, and refuses rather than half-sending.
 */
describe('SMS broadcast (e2e, GAP-15)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let owner: string[];
  let campusAdmin: string[];
  let campusA: string;
  let campusB: string;
  let classA: string;
  let admitA: (dto: object) => request.Test;
  let admitB: (dto: object) => request.Test;

  const sub = `bc-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const ownerLogin = { email: 'owner@bc.pk', password: 'Owner!Secret12' };
  const staffPassword = 'Staff!Secret12';

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object, cookies = owner) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send(b);

  const verify = async (parentId: string, extra: object = {}) =>
    platform.parentProfile.update({ where: { id: parentId }, data: { phoneVerifiedAt: new Date(), ...extra } });

  async function student(campusId: string, classId: string, sectionId: string, guardian: object) {
    const res = await (campusId === campusA ? admitA : admitB)({ fullName: `Kid ${randomUUID().slice(0, 4)}`, gender: 'MALE', dateOfBirth: '2014-01-01', campusId, classId, sectionId, guardian });
    expect(res.status).toBe(201);
    return res.body as { studentId: string; parentId: string };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    platform = app.get(PlatformPrismaService);

    const prov = await app.get(ProvisioningService, { strict: false })
      .provisionSchool({ name: 'Broadcast School', subdomain: sub, ownerEmail: ownerLogin.email, ownerPassword: ownerLogin.password });
    schoolId = prov.schoolId;
    campusA = prov.campusId;
    owner = (await loginRequest(server(), host, ownerLogin.email, ownerLogin.password)).headers['set-cookie'] as unknown as string[];
    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    campusB = (await post('/api/v1/campuses', { name: 'Campus B' })).body.id;
    // Admission is a per-campus seat, so each campus needs its own controller.
    ({ admit: admitA } = await admissionController(app, platform, schoolId, host, campusA));
    ({ admit: admitB } = await admissionController(app, platform, schoolId, host, campusB));

    classA = (await post('/api/v1/classes', { campusId: campusA, name: 'Five', order: 5 })).body.id;
    const sectionA = (await post('/api/v1/sections', { classId: classA, name: 'A' })).body.id;
    const classB = (await post('/api/v1/classes', { campusId: campusB, name: 'Five B', order: 5 })).body.id;
    const sectionB = (await post('/api/v1/sections', { classId: classB, name: 'A' })).body.id;

    // Campus A, Class Five: two siblings sharing a verified mother, one opted-out family, one unverified family.
    const sib = await student(campusA, classA, sectionA, { mode: 'CREATE', fullName: 'Mother', phone: '03005550001', relation: 'MOTHER' });
    await verify(sib.parentId);
    await student(campusA, classA, sectionA, { mode: 'LINK', parentId: sib.parentId, relation: 'MOTHER' });
    const opted = await student(campusA, classA, sectionA, { mode: 'CREATE', fullName: 'Stop', phone: '03005550002', relation: 'FATHER' });
    await verify(opted.parentId, { smsOptOut: true });
    await student(campusA, classA, sectionA, { mode: 'CREATE', fullName: 'Unverified', phone: '03005550003', relation: 'FATHER' });
    // Campus B: one reachable family.
    const b = await student(campusB, classB, sectionB, { mode: 'CREATE', fullName: 'Campus B parent', phone: '03005550004', relation: 'MOTHER' });
    await verify(b.parentId);

    await platform.user.create({
      data: { schoolId, campusId: campusA, email: 'admin-a@bc.pk', roles: ['CAMPUS_ADMIN'] as never, status: 'ACTIVE',
        passwordHash: await argon2.hash(staffPassword, { type: argon2.argon2id }) },
    });
    campusAdmin = (await loginRequest(server(), host, 'admin-a@bc.pk', staffPassword)).headers['set-cookie'] as unknown as string[];
  });

  afterAll(async () => {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('previews a class: one text per family, and why the others are skipped', async () => {
    const res = await post('/api/v1/sms/broadcast/preview', { classId: classA, body: 'School closed tomorrow' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      students: 4, recipients: 1, skipped: { noGuardian: 0, unverified: 1, optedOut: 1 },
      segmentsPerMessage: 1, totalSegments: 1,
    });
  });

  it('keeps a campus admin inside their campus, whatever campus they name', async () => {
    const res = await post('/api/v1/sms/broadcast/preview', { campusId: campusB, body: 'Hello' }, campusAdmin);
    expect(res.status).toBe(200);
    // Campus A only: the mother of the siblings. Campus B's parent is not in their reach.
    expect(res.body.recipients).toBe(1);
    expect(res.body.students).toBe(4);
  });

  it('sends to the families the preview promised, and records who sent what', async () => {
    const res = await post('/api/v1/sms/broadcast', { body: 'Parent meeting on Saturday', expectedRecipients: 2 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ queued: 2, totalSegments: 2 });

    await drainSmsFor(app, schoolId);
    const logs = await platform.smsLog.findMany({ where: { schoolId, templateKey: 'MANUAL', message: 'Parent meeting on Saturday' } });
    // Phones are stored normalised (+92…), so compare on the subscriber digits.
    expect(logs.map((l) => l.recipient.slice(-7)).sort()).toEqual(['5550001', '5550004']);
    // The opted-out parent was never texted.

    const audit = await platform.auditLog.findFirst({ where: { schoolId, action: 'SMS_BROADCAST_SENT' } });
    expect(audit).not.toBeNull();
  });

  it('refuses when the audience changed since it was previewed', async () => {
    const res = await post('/api/v1/sms/broadcast', { body: 'Hi', expectedRecipients: 7 });
    expect(res.status).toBe(409);
  });

  it('refuses the whole broadcast rather than half-sending when credits are short', async () => {
    const before = await platform.smsLog.count({ where: { schoolId } });
    const balance = (await request(server()).get('/api/v1/sms/credits').set('Host', host).set('Cookie', owner)).body.balance as number;
    await platform.smsCreditLedger.create({ data: { schoolId, delta: -(balance - 1), refType: 'SEND' } });

    const res = await post('/api/v1/sms/broadcast', { body: 'Two families, one credit', expectedRecipients: 2 });
    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error?.code).toBe('INSUFFICIENT_SMS_CREDITS');
    await drainSmsFor(app, schoolId);
    expect(await platform.smsLog.count({ where: { schoolId } })).toBe(before);
  });
});
