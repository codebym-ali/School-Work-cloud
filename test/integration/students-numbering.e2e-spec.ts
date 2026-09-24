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
import { loginRequest } from './support/login';

/**
 * GR / Registration numbering (QA C). The GR number is a child's permanent identity (leaving certificate,
 * every receipt), so it must be one consistent, professional shape school-wide: `<prefix>` + a zero-padded
 * counter (GR-0031, never GR-31 or a bare 31), issued from a per-school counter and contiguous. This pins
 * the generator so a live admission matches what the seed writes (GR-0001…), closing the format drift.
 */
describe('Student numbering — GR/Reg format & contiguity (e2e)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let admitStudent: (n: number) => request.Test;
  const host = `num-${randomUUID().slice(0, 6)}.localhost`;
  const email = 'owner@num.pk';
  const password = 'Owner!Secret12';

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    platform = app.get(PlatformPrismaService);

    const prov = await app.get(ProvisioningService, { strict: false }).provisionSchool({ name: 'Num School', subdomain: host.split('.')[0], ownerEmail: email, ownerPassword: password });
    schoolId = prov.schoolId;
    const cookies = (await loginRequest(server(), host, email, password)).headers['set-cookie'] as unknown as string[];
    const csrf = csrfOf(cookies);
    const post = (p: string, body: object) =>
      request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).send(body);

    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    const classId = (await post('/api/v1/classes', { campusId: prov.campusId, name: 'Grade 1', order: 1 })).body.id;
    const sectionId = (await post('/api/v1/sections', { classId, name: 'A' })).body.id;

    // A school that has set a GR prefix and a starting counter (as the seed now does): the next admission
    // must continue that register, prefixed and padded.
    await platform.school.update({ where: { id: schoolId }, data: { grPrefix: 'GR-', nextGrNumber: 31, registrationPrefix: 'REG-2026-', nextRegistrationNo: 31 } });

    const { admit } = await admissionController(app, platform, schoolId, host, prov.campusId);
    admitStudent = (n: number) => admit({
      fullName: `Num Child ${n}`, gender: 'MALE', dateOfBirth: '2018-05-10', campusId: prov.campusId, classId, sectionId,
      guardian: { mode: 'CREATE', fullName: `G ${n}`, phone: `0300700${String(1000 + n)}`, relation: 'FATHER' },
    });
  }, 120_000);

  afterAll(async () => {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    if (schoolId) await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('issues prefixed, zero-padded, contiguous GR & registration numbers', async () => {
    const a = await admitStudent(1);
    const b = await admitStudent(2);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    // Canonical shape: prefix + 4-digit zero-padded counter — never a bare number.
    expect(a.body.grNumber).toBe('GR-0031');
    expect(b.body.grNumber).toBe('GR-0032'); // contiguous
    expect(a.body.registrationNo).toBe('REG-2026-0031');
    expect(b.body.registrationNo).toBe('REG-2026-0032');
    expect(a.body.grNumber).toMatch(/^GR-\d{4}$/);
  });
});
