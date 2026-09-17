import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
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
 * Defaulters as a working list, and fee reminders (GAP-13).
 *
 * The `FEE_REMINDER` template existed and nothing sent it. These cases pin the pipeline built for it —
 * including the parts that decide whether a family is actually told: only verified, non-opted-out numbers
 * are texted, amounts come from the server, and one family is reminded at most once a day.
 *
 * ⚠️ July 2026 has begun and is past due (a defaulter); November 2026 has not (not a defaulter). A
 * future-dated invoice is never a defaulter, so a student billed only for November proves "not defaulting".
 */
describe('Defaulters and fee reminders (e2e, GAP-13)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let campusId: string;
  let yearId: string;
  let feeHeadId: string;
  let admit: (dto: object) => request.Test;

  const sub = `dft-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@dft.pk', password: 'Owner!Secret12' };
  const JULY = { month: 7, year: 2026 };
  const NOVEMBER = { month: 11, year: 2026 };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send(b);
  const get = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

  let n = 0;
  async function billed(months: Array<{ month: number; year: number }>, phone: string) {
    n += 1;
    const classId = (await post('/api/v1/classes', { campusId, name: `D-${n}`, order: 200 + n })).body.id;
    const sectionId = (await post('/api/v1/sections', { classId, name: 'A' })).body.id;
    await post('/api/v1/fee-structures', { campusId, classId, feeHeadId, academicYearId: yearId, amount: 3000, frequency: 'MONTHLY' });
    const admitted = await admit({
      fullName: `Owing ${n}`, gender: 'FEMALE', dateOfBirth: '2013-03-03', campusId, classId, sectionId,
      guardian: { mode: 'CREATE', fullName: `Guardian ${n}`, phone, relation: 'MOTHER' },
    });
    expect(admitted.status).toBe(201);
    await platform.studentEnrollment.update({ where: { id: admitted.body.enrollmentId }, data: { startedAt: new Date('2026-04-01') } });
    for (const m of months) expect((await post('/api/v1/fees/invoice-batches', { classId, ...m })).status).toBeLessThan(300);
    return admitted.body.studentId as string;
  }
  const verifyGuardianOf = async (studentId: string) => {
    const link = await platform.studentGuardian.findFirstOrThrow({ where: { studentId, isPrimary: true } });
    await platform.parentProfile.update({ where: { id: link.parentId }, data: { phoneVerifiedAt: new Date() } });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    platform = app.get(PlatformPrismaService);

    const prov = await app.get(ProvisioningService, { strict: false })
      .provisionSchool({ name: 'Defaulter School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;
    campusId = prov.campusId;
    cookies = (await loginRequest(server(), host, owner.email, owner.password)).headers['set-cookie'] as unknown as string[];
    yearId = (await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true })).body.id;
    feeHeadId = (await post('/api/v1/fee-heads', { name: 'Tuition' })).body.id;
    ({ admit } = await admissionController(app, platform, schoolId, host, campusId));
  });

  afterAll(async () => {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('lists who to contact, and whether an SMS can reach them', async () => {
    const studentId = await billed([JULY], '03004440001');
    const row = (await get('/api/v1/fees/defaulters')).body.find((d: { student: { id: string } }) => d.student.id === studentId);

    expect(row).toMatchObject({ outstanding: 3000, invoices: 1 });
    expect(row.daysOverdue).toBeGreaterThan(0);
    expect(row.guardian).toMatchObject({ name: `Guardian ${n}`, relation: 'MOTHER', canText: false }); // unverified

    await verifyGuardianOf(studentId);
    const after = (await get('/api/v1/fees/defaulters')).body.find((d: { student: { id: string } }) => d.student.id === studentId);
    expect(after.guardian.canText).toBe(true);
  });

  it('texts only who it can, skips who it cannot, and states the amount the SERVER holds', async () => {
    const reachable = await billed([JULY], '03004440002');
    await verifyGuardianOf(reachable);
    const unverified = await billed([JULY], '03004440003');
    const notOwing = await billed([NOVEMBER], '03004440004');
    await verifyGuardianOf(notOwing);

    const res = await post('/api/v1/fees/defaulters/reminders', { studentIds: [reachable, unverified, notOwing] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ queued: 1, skipped: { notDefaulting: 1, cannotText: 1 } });

    await drainSmsFor(app, schoolId);
    const logs = await platform.smsLog.findMany({ where: { schoolId, templateKey: 'FEE_REMINDER', studentId: reachable } });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('SENT');
    expect(logs[0].message).toContain('3,000');
    expect(logs[0].message).toMatch(/outstanding since 2026-07/);
  });

  it('reminds a family at most once a day, however many times the list is sent', async () => {
    const studentId = await billed([JULY], '03004440005');
    await verifyGuardianOf(studentId);

    await post('/api/v1/fees/defaulters/reminders', { studentIds: [studentId] });
    await drainSmsFor(app, schoolId);
    await post('/api/v1/fees/defaulters/reminders', { studentIds: [studentId] });
    await drainSmsFor(app, schoolId);

    const sent = await platform.smsLog.count({ where: { schoolId, templateKey: 'FEE_REMINDER', studentId, status: 'SENT' } });
    expect(sent).toBe(1);
  });

  it('refuses an empty or malformed list', async () => {
    expect((await post('/api/v1/fees/defaulters/reminders', { studentIds: [] })).status).toBe(400);
    expect((await post('/api/v1/fees/defaulters/reminders', { studentIds: ['not-an-id'] })).status).toBe(400);
  });
});
