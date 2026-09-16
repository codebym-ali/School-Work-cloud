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
 * Guardians after admission (GAP-07).
 *
 * The model supported many guardians from the start; nothing could change them once admitted. These
 * cases pin the corrections an office actually makes — and the three defects found building the screen:
 * `relation` accepted by PATCH and silently ignored, a first guardian that was not primary, and a
 * concurrent primary change surfacing as a 500.
 */
describe('Guardians after admission (e2e, GAP-07)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];
  let campusId: string;
  let classId: string;
  let sectionId: string;
  let admit: (dto: object) => request.Test;
  let officer: { cookies: string[]; csrf: string };

  const sub = `grd-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@grd.pk', password: 'Owner!Secret12' };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const send = (method: 'post' | 'patch' | 'delete', p: string, b: object = {}) =>
    request(server())[method](p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send(b);
  const get = (p: string) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

  let roll = 1;
  /** A student admitted WITHOUT a guardian — the case this screen exists to finish. */
  const admitBare = async (name: string) => {
    const res = await admit({ fullName: name, gender: 'FEMALE', dateOfBirth: '2014-02-01', campusId, classId, sectionId, rollNumber: roll++ });
    expect(res.status).toBe(201);
    return res.body.studentId as string;
  };
  const guardiansOf = async (studentId: string) =>
    (await get(`/api/v1/students/${studentId}`)).body.guardians as Array<{
      id: string; relation: string; isPrimary: boolean;
      parent: { id: string; fullName: string; phone: string; phoneVerifiedAt: string | null; _count: { guardianLinks: number } };
    }>;
  const addNew = (studentId: string, fullName: string, phone: string, relation: string, isPrimary?: boolean) =>
    send('post', `/api/v1/students/${studentId}/guardians`, { mode: 'CREATE', fullName, phone, relation, ...(isPrimary === undefined ? {} : { isPrimary }) });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    platform = app.get(PlatformPrismaService);

    const prov = await app.get(ProvisioningService, { strict: false })
      .provisionSchool({ name: 'Guardian School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;
    campusId = prov.campusId;

    cookies = (await loginRequest(server(), host, owner.email, owner.password)).headers['set-cookie'] as unknown as string[];
    await send('post', '/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    classId = (await send('post', '/api/v1/classes', { campusId, name: 'Grade 6', order: 6 })).body.id;
    sectionId = (await send('post', '/api/v1/sections', { classId, name: 'A' })).body.id;
    const ac = await admissionController(app, platform, schoolId, host, campusId);
    admit = ac.admit;
    officer = { cookies: ac.cookies, csrf: ac.csrf };
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('makes a student’s FIRST guardian primary even when not asked', async () => {
    // ⚠️ Every receipt and SMS resolves the primary. An only guardian that is not primary is contacted
    // by nobody, while the profile shows a guardian on record.
    const studentId = await admitBare('First Guardian');
    expect((await addNew(studentId, 'Nadia Iqbal', '03215550001', 'MOTHER', false)).status).toBe(204);

    const [only] = await guardiansOf(studentId);
    expect(only.isPrimary).toBe(true);
  });

  it('adds a second guardian as non-primary, and lists the primary first', async () => {
    const studentId = await admitBare('Two Guardians');
    await addNew(studentId, 'Asif Iqbal', '03215550002', 'FATHER');
    await addNew(studentId, 'Sana Iqbal', '03215550003', 'MOTHER');

    const list = await guardiansOf(studentId);
    expect(list.map((g) => [g.parent.fullName, g.isPrimary])).toEqual([['Asif Iqbal', true], ['Sana Iqbal', false]]);
  });

  it('actually changes the relation — PATCH used to return 204 and change nothing', async () => {
    const studentId = await admitBare('Relation Fix');
    await addNew(studentId, 'Tariq Mehmood', '03215550004', 'FATHER');
    const [g] = await guardiansOf(studentId);

    expect((await send('patch', `/api/v1/students/${studentId}/guardians/${g.id}`, { relation: 'GUARDIAN' })).status).toBe(204);
    expect((await guardiansOf(studentId))[0].relation).toBe('GUARDIAN');
  });

  it('moves primary, leaving exactly one', async () => {
    const studentId = await admitBare('Primary Move');
    await addNew(studentId, 'Kamran Ali', '03215550005', 'FATHER');
    await addNew(studentId, 'Rabia Ali', '03215550006', 'MOTHER');
    const mother = (await guardiansOf(studentId)).find((g) => g.relation === 'MOTHER')!;

    expect((await send('patch', `/api/v1/students/${studentId}/guardians/${mother.id}`, { isPrimary: true })).status).toBe(204);
    const after = await guardiansOf(studentId);
    expect(after.filter((g) => g.isPrimary).map((g) => g.parent.fullName)).toEqual(['Rabia Ali']);
  });

  it('never answers a concurrent primary change with a 500, and never leaves two primaries', async () => {
    const studentId = await admitBare('Primary Race');
    await addNew(studentId, 'Primary Now', '03215550007', 'FATHER');
    await addNew(studentId, 'Candidate One', '03215550008', 'MOTHER');
    await addNew(studentId, 'Candidate Two', '03215550009', 'GUARDIAN');
    const [, one, two] = await guardiansOf(studentId);

    // Two different people promote two different guardians at once. Serialised, both succeed and the
    // later wins; colliding, the partial UNIQUE index refuses one. Either is correct — a 500 is not.
    const results = await Promise.all([
      send('patch', `/api/v1/students/${studentId}/guardians/${one.id}`, { isPrimary: true }),
      send('patch', `/api/v1/students/${studentId}/guardians/${two.id}`, { isPrimary: true }),
    ]);
    for (const r of results) expect([204, 409]).toContain(r.status);
    expect(results.some((r) => r.status === 204)).toBe(true);
    expect((await guardiansOf(studentId)).filter((g) => g.isPrimary)).toHaveLength(1);
  });

  describe('contact corrections', () => {
    it('changes a number for every child of that guardian, and marks it unverified again', async () => {
      // Siblings: one guardian record, two links.
      const olderId = await admitBare('Older Sibling');
      await addNew(olderId, 'Imran Qureshi', '03215550010', 'FATHER');
      const parent = (await guardiansOf(olderId))[0].parent;
      const youngerId = await admitBare('Younger Sibling');
      expect((await send('post', `/api/v1/students/${youngerId}/guardians`, { mode: 'LINK', parentId: parent.id, relation: 'FATHER' })).status).toBe(204);

      // The number had been verified; a NEW number must not inherit that.
      await platform.parentProfile.update({ where: { id: parent.id }, data: { phoneVerifiedAt: new Date() } });
      const link = (await guardiansOf(olderId))[0];

      const res = await send('patch', `/api/v1/students/${olderId}/guardians/${link.id}/contact`, { phone: '0321-555-0099' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ phoneChanged: true, phoneVerified: false, childCount: 2 });

      // Seen from the OTHER child: the same record, the new number, and SMS off until re-verified.
      const fromYounger = (await guardiansOf(youngerId))[0].parent;
      expect(fromYounger.phone).toBe((await platform.parentProfile.findUniqueOrThrow({ where: { id: parent.id } })).phone);
      expect(fromYounger.phoneVerifiedAt).toBeNull();
      expect(fromYounger._count.guardianLinks).toBe(2);
    });

    it('keeps verification when only the name changes', async () => {
      const studentId = await admitBare('Name Only');
      await addNew(studentId, 'Speling Mistake', '03215550011', 'FATHER');
      const g = (await guardiansOf(studentId))[0];
      await platform.parentProfile.update({ where: { id: g.parent.id }, data: { phoneVerifiedAt: new Date() } });

      const res = await send('patch', `/api/v1/students/${studentId}/guardians/${g.id}/contact`, { fullName: 'Spelling Fixed' });
      expect(res.body).toMatchObject({ phoneChanged: false, phoneVerified: true });
      expect((await guardiansOf(studentId))[0].parent.phoneVerifiedAt).not.toBeNull();
    });

    it('refuses a number another guardian already holds, naming them so they can be linked instead', async () => {
      const aId = await admitBare('Clash A');
      await addNew(aId, 'Holds The Number', '03215550012', 'MOTHER');
      const holder = (await guardiansOf(aId))[0].parent;

      const bId = await admitBare('Clash B');
      await addNew(bId, 'Wants The Number', '03215550013', 'MOTHER');
      const wants = (await guardiansOf(bId))[0];

      const res = await send('patch', `/api/v1/students/${bId}/guardians/${wants.id}/contact`, { phone: '03215550012' });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain('Holds The Number');
      expect(res.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'parentId', issue: holder.id })]));
    });

    it('refuses the admission controller editing a guardian it may still add', async () => {
      // Add is open to the officer, so a record started at admission can be finished; rewriting an
      // existing guardian stays with the admins. The UI hides Edit for this role on the same rule.
      const studentId = await admitBare('Officer Scope');
      await addNew(studentId, 'Officer Target', '03215550014', 'FATHER');
      const g = (await guardiansOf(studentId))[0];
      const res = await request(server())
        .patch(`/api/v1/students/${studentId}/guardians/${g.id}/contact`)
        .set('Host', host).set('Cookie', officer.cookies).set('X-CSRF-Token', officer.csrf)
        .send({ fullName: 'Nope' });
      expect(res.status).toBe(403);
    });
  });
});
