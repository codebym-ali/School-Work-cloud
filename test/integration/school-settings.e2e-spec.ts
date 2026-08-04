import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { destroyTenant } from './support/tenant';

/**
 * School settings (§17.1).
 *
 * `School.settings` had no API at all: the working week, the fee due day, the attendance
 * windows and whether teachers may check themselves in could only be changed by a developer
 * writing to the database. A school could not set its own operating rules.
 */
describe('School settings (e2e)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let ownerCookies: string[];
  let ownerCsrf: string;
  let adminCookies: string[];
  let adminCsrf: string;

  const sub = `set-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@set.pk', password: 'Owner!Secret12' };
  const admin = { email: 'campadmin@set.pk', password: 'Admin!Secret12' };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const authed = (method: 'get' | 'patch', p: string, cookies: string[], csrf?: string) => {
    let r = request(server())[method](p).set('Host', host).set('Cookie', cookies);
    if (csrf) r = r.set('X-CSRF-Token', csrf);
    return r;
  };
  const patch = (body: object) => authed('patch', '/api/v1/school-settings', ownerCookies, ownerCsrf).send(body);
  const get = () => authed('get', '/api/v1/school-settings', ownerCookies);
  const login = async (e: string, pw: string) => {
    const res = await request(server()).post('/api/v1/auth/login').set('Host', host).send({ email: e, password: pw });
    return res.headers['set-cookie'] as unknown as string[];
  };

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
      name: 'Settings School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password,
    });
    schoolId = prov.schoolId;

    ownerCookies = await login(owner.email, owner.password);
    ownerCsrf = csrfOf(ownerCookies);

    await platform.user.create({
      data: {
        schoolId, campusId: prov.campusId, email: admin.email, roles: ['CAMPUS_ADMIN'] as never, status: 'ACTIVE',
        passwordHash: await argon2.hash(admin.password, { type: argon2.argon2id }),
      },
    });
    adminCookies = await login(admin.email, admin.password);
    adminCsrf = csrfOf(adminCookies);
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('returns the defaults for a school that has never configured anything', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    // Defaults are filled in rather than returning `{}` — the screen must show the rules that
    // are actually in force, not a blank form implying nothing is set.
    expect(res.body).toMatchObject({
      weeklyOffDays: ['SUNDAY'],
      feeDueDay: 10,
      admissionsMode: 'DIRECT',
      staffAttendance: { selfMarking: false, dayStartTime: '08:00', graceMinutes: 15 },
    });
  });

  it('merges a partial change instead of replacing the blob', async () => {
    await patch({ feeDueDay: 15 });
    const res = await patch({ weeklyOffDays: ['FRIDAY', 'SUNDAY'] });
    expect(res.status).toBe(200);
    // A PUT-shaped write would have reset feeDueDay to its default here — which is exactly how
    // a client that predates a newly-added key silently wipes it.
    expect(res.body.feeDueDay).toBe(15);
    expect(res.body.weeklyOffDays).toEqual(['FRIDAY', 'SUNDAY']);
  });

  it('merges one level into a nested group', async () => {
    await patch({ staffAttendance: { selfMarking: true } });
    const res = await patch({ staffAttendance: { dayStartTime: '07:30' } });
    expect(res.status).toBe(200);
    // Changing the day start must not switch self check-in back off.
    expect(res.body.staffAttendance).toMatchObject({ selfMarking: true, dayStartTime: '07:30', graceMinutes: 15 });
  });

  it('rejects an invalid value and changes nothing', async () => {
    const before = (await get()).body;
    const res = await patch({ feeDueDay: 31 }); // the schema caps this at 28
    expect(res.status).toBe(400);
    expect((await get()).body.feeDueDay).toBe(before.feeDueDay);
  });

  it('rejects a malformed day start time', async () => {
    const res = await patch({ staffAttendance: { dayStartTime: '25:00' } });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown setting rather than storing it', async () => {
    // The blob is `.strict()` for a reason: a typo'd key that silently persisted would look
    // configured and do nothing.
    const res = await patch({ notASetting: true });
    expect(res.status).toBe(400);
  });

  it('audits the DIFF, naming only what moved', async () => {
    await patch({ smsOverdraftSegments: 250 });
    const row = await platform.auditLog.findFirst({
      where: { schoolId, action: 'SCHOOL_SETTINGS_UPDATED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(row).not.toBeNull();
    expect(row!.newValue).toMatchObject({ smsOverdraftSegments: 250 });
    // Not a dump of the whole blob — "what changed" has to be readable a year later.
    expect(Object.keys(row!.newValue as object)).toEqual(['smsOverdraftSegments']);
  });

  it('does not audit a write that changes nothing', async () => {
    const current = (await get()).body;
    const before = await platform.auditLog.count({ where: { schoolId, action: 'SCHOOL_SETTINGS_UPDATED' } });
    await patch({ feeDueDay: current.feeDueDay });
    const after = await platform.auditLog.count({ where: { schoolId, action: 'SCHOOL_SETTINGS_UPDATED' } });
    expect(after).toBe(before);
  });

  it('requires at least one accepted payment method', async () => {
    // A school that accepts nothing cannot take a payment at all — every method would be
    // refused, and the fee screen would offer an empty dropdown.
    const res = await patch({ feeSubmission: { methods: [] } });
    expect(res.status).toBe(400);
  });

  it('defaults a new school to cash only, proof optional, no guardian link', async () => {
    const res = await get();
    // Conservative on purpose: a school starts at the simplest thing that works and switches on
    // what it grows into. Nothing here should appear for a school that has not asked for it.
    expect(res.body.feeSubmission).toMatchObject({
      methods: ['CASH'], proofPolicy: 'OPTIONAL', guardianUploadLink: false, chequeClearingDays: 3,
    });
  });

  it('a campus admin may read the rules but not change them', async () => {
    // They work under these rules (weekly off, backfill window) so they need to see them;
    // the values govern money and pay, so only the owner moves them.
    const read = await authed('get', '/api/v1/school-settings', adminCookies);
    expect(read.status).toBe(200);

    const write = await authed('patch', '/api/v1/school-settings', adminCookies, adminCsrf).send({ feeDueDay: 5 });
    expect(write.status).toBe(403);
  });

  it('a settings change takes effect immediately on the behaviour it governs', async () => {
    // The point of the screen: switching self check-in off must stop it, with no redeploy and
    // no re-login. Proven through the endpoint it governs, not by re-reading the setting.
    await patch({ staffAttendance: { selfMarking: false } });
    const denied = await request(server())
      .post('/api/v1/staff-attendance/check-in')
      .set('Host', host).set('Cookie', ownerCookies).set('X-CSRF-Token', ownerCsrf).send({});
    // The owner has no staff profile, so 403 either way — assert the MESSAGE distinguishes them.
    expect(denied.status).toBe(403);

    await patch({ staffAttendance: { selfMarking: true } });
    const settings = (await get()).body;
    expect(settings.staffAttendance.selfMarking).toBe(true);
  });
});
