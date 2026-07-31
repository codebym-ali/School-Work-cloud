import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { admissionController } from './support/admission';
import { SMS_GATEWAY, type SendResult } from '../../apps/api/src/modules/comms/sms/sms-gateway';
import { destroyTenant } from './support/tenant';

/**
 * Guardian phone OTP verification (§14). A capturing SMS gateway lets us read the code the
 * service sent, then confirm it. Verifies: wrong code is rejected, the right code sets
 * phoneVerifiedAt, and the code is never stored/returned in plaintext.
 */
describe('Guardian phone OTP (e2e, §14)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let csrf: string;
  let parentId: string;

  const sent: string[] = []; // messages the gateway "sent"
  const fakeGateway = {
    send: async (_to: string, message: string): Promise<SendResult> => {
      sent.push(message);
      return { gatewayMessageId: `test-${Date.now()}`, accepted: true };
    },
  };

  const sub = `otp-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const email = 'owner@otp.pk';
  const password = 'Owner!Secret12';
  const server = () => app.getHttpServer();
  const post = (p: string, b: object = {}) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).send(b);

  const codeFrom = (msg: string) => (msg.match(/\b(\d{6})\b/)?.[1] ?? '');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SMS_GATEWAY)
      .useValue(fakeGateway)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const provisioning = app.get(ProvisioningService, { strict: false });
    const prov = await provisioning.provisionSchool({ name: 'OTP School', subdomain: sub, ownerEmail: email, ownerPassword: password });
    schoolId = prov.schoolId;

    const login = await request(server()).post('/api/v1/auth/login').set('Host', host).send({ email, password });
    cookies = login.headers['set-cookie'] as unknown as string[];
    csrf = (cookies.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);

    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    const klass = await post('/api/v1/classes', { campusId: prov.campusId, name: 'Grade 1', order: 1 });
    const section = await post('/api/v1/sections', { classId: klass.body.id, name: 'A' });
    const { admit } = await admissionController(app, platform, schoolId, host, prov.campusId);
    const student = await admit({
      fullName: 'Kid One', gender: 'MALE', dateOfBirth: '2015-05-10', campusId: prov.campusId, classId: klass.body.id, sectionId: section.body.id,
      guardian: { mode: 'CREATE', fullName: 'Papa', phone: '03007654321', relation: 'FATHER' },
    });
    parentId = student.body.parentId;
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('guardian starts unverified', async () => {
    const p = await platform.parentProfile.findFirst({ where: { id: parentId } });
    expect(p?.phoneVerifiedAt).toBeNull();
  });

  it('request sends a 6-digit OTP by SMS, masks the number, stores no plaintext', async () => {
    sent.length = 0;
    const res = await post(`/api/v1/students/guardians/${parentId}/verify-phone`);
    expect(res.status).toBe(201);
    expect(res.body.sentTo).toMatch(/\*+4321$/); // masked, last 4 shown
    expect(sent).toHaveLength(1);
    expect(codeFrom(sent[0])).toMatch(/^\d{6}$/);
    // The code is stored only as a hash, never plaintext.
    const p = await platform.parentProfile.findFirst({ where: { id: parentId } });
    expect(p?.otpCodeHash).toBeTruthy();
    expect(p?.otpCodeHash).not.toContain(codeFrom(sent[0]));
  });

  it('rejects a wrong code, accepts the right one and sets phoneVerifiedAt', async () => {
    const wrong = await post(`/api/v1/students/guardians/${parentId}/verify-phone/confirm`, { code: '000000' });
    // '000000' is only wrong if the real code differs; guard against the 1-in-1e6 collision.
    const real = codeFrom(sent[sent.length - 1]);
    if (real !== '000000') expect(wrong.status).toBe(422);

    const ok = await post(`/api/v1/students/guardians/${parentId}/verify-phone/confirm`, { code: real });
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ verified: true });

    const p = await platform.parentProfile.findFirst({ where: { id: parentId } });
    expect(p?.phoneVerifiedAt).not.toBeNull();
    expect(p?.otpCodeHash).toBeNull(); // challenge cleared
  });

  it('rejects a bad (non-6-digit) code shape at validation (400)', async () => {
    const res = await post(`/api/v1/students/guardians/${parentId}/verify-phone/confirm`, { code: 'abc' });
    expect(res.status).toBe(400);
  });
});
