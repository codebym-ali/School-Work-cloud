import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { destroyTenant } from './support/tenant';
import { admissionController } from './support/admission';

/**
 * Guardian is OPTIONAL at admission (§8) — a walk-in can be seated before the guardian's
 * details are collected.
 *
 * The risk this pins down is not a crash (every downstream reader already bails out on a
 * missing primary guardian) — it is SILENCE: such a student receives no absence, fee-receipt
 * or result SMS, for ever, with nothing to say so. So the contract under test is that the gap
 * is (a) allowed, (b) visible via `hasGuardian`, (c) findable via `?missingGuardian=true`,
 * and (d) closable by the same person who created it.
 */
describe('Guardian optional at admission (e2e)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let campusId: string;
  let classId: string;
  let sectionId: string;
  let admit: (dto: object) => request.Test;
  let acCookies: string[];
  let acCsrf: string;
  let orphanId: string;

  const sub = `gop-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@gop.pk', password: 'Owner!Secret12' };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object) =>
    request(server()).post(p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send(b);
  const get = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

  const base = (name: string) => ({
    fullName: name, gender: 'MALE', dateOfBirth: '2013-04-01', campusId, classId, sectionId,
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
    const prov = await provisioning.provisionSchool({ name: 'GOP School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;
    campusId = prov.campusId;

    const login = await request(server()).post('/api/v1/auth/login').set('Host', host).send(owner);
    cookies = login.headers['set-cookie'] as unknown as string[];

    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    classId = (await post('/api/v1/classes', { campusId, name: 'Grade 9', order: 9 })).body.id;
    sectionId = (await post('/api/v1/sections', { classId, name: 'A' })).body.id;

    const ac = await admissionController(app, platform, schoolId, host, campusId);
    admit = ac.admit;
    acCookies = ac.cookies;
    acCsrf = ac.csrf;
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('admits a student with no guardian at all', async () => {
    const res = await admit(base('No Guardian Kid'));
    expect(res.status).toBe(201);
    expect(res.body.grNumber).toBeTruthy();
    expect(res.body.registrationNo).toBeTruthy();
    orphanId = res.body.studentId;

    // No parent was invented to satisfy the old required field — zero links, zero profiles.
    const links = await platform.studentGuardian.count({ where: { studentId: orphanId } });
    expect(links).toBe(0);
    const parents = await platform.parentProfile.count({ where: { schoolId } });
    expect(parents).toBe(0);
  });

  it('flags the gap in the directory and makes it findable', async () => {
    const withG = await admit({
      ...base('Has Guardian Kid'),
      guardian: { mode: 'CREATE', fullName: 'A Parent', phone: '03110000009', relation: 'FATHER' },
    });
    expect(withG.status).toBe(201);

    const all = await get('/api/v1/students');
    expect(all.status).toBe(200);
    const byName = Object.fromEntries(all.body.data.map((s: { fullName: string; hasGuardian: boolean }) => [s.fullName, s.hasGuardian]));
    expect(byName['No Guardian Kid']).toBe(false);
    expect(byName['Has Guardian Kid']).toBe(true);

    // The chase list returns only the student nobody can be contacted about.
    const missing = await get('/api/v1/students?missingGuardian=true');
    expect(missing.status).toBe(200);
    expect(missing.body.data.map((s: { fullName: string }) => s.fullName)).toEqual(['No Guardian Kid']);
  });

  it('still rejects a HALF-filled guardian — omitting is a choice, not a typo', async () => {
    // CREATE with a name but no phone: the section was started and left incomplete, which
    // must fail rather than quietly admit with no guardian.
    const res = await admit({
      ...base('Half Guardian Kid'),
      guardian: { mode: 'CREATE', fullName: 'Nameless Phone', relation: 'FATHER' },
    });
    expect(res.status).toBe(400);
  });

  it('lets the admission officer close the gap afterwards, and the flag clears', async () => {
    const res = await request(server())
      .post(`/api/v1/students/${orphanId}/guardians`)
      .set('Host', host)
      .set('Cookie', acCookies)
      .set('X-CSRF-Token', acCsrf)
      .send({ mode: 'CREATE', fullName: 'Late Parent', phone: '03110000010', relation: 'FATHER', isPrimary: true });
    expect(res.status).toBe(204);

    const after = await get('/api/v1/students?missingGuardian=true');
    expect(after.body.data).toHaveLength(0);

    const row = (await get('/api/v1/students')).body.data.find((s: { id: string }) => s.id === orphanId);
    expect(row.hasGuardian).toBe(true);

    // The late guardian is the PRIMARY one — otherwise SMS would still reach nobody.
    const link = await platform.studentGuardian.findFirst({ where: { studentId: orphanId } });
    expect(link?.isPrimary).toBe(true);
  });
});
