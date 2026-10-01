import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { destroyTenant } from './support/tenant';
import { loginRequest } from './support/login';
import { enrolMfa } from './support/mfa';

/**
 * Operations Admin (RBAC) — the owner's school-wide operational deputy (Operations Admin Role Plan).
 *
 * Proves the whole ceiling in one place:
 *  - the OWNER appoints/revokes the deputy (grant OPERATIONS_ADMIN on an existing employee);
 *  - the DEPUTY can do a campus-admin's operational job it could not do as a plain teacher
 *    (list users, create lower staff, grant lower access roles);
 *  - OP-1 the deputy CANNOT appoint another deputy (grant/ create OPERATIONS_ADMIN) → 403;
 *  - OP-2 the deputy CANNOT touch a user at or above its own level — the owner, or another
 *    deputy (update / reset-password / re-role) → 403;
 *  - owner-only roots of trust stay owner-only for the deputy: module-access toggles and
 *    removing a user → 403;
 *  - the owner can revoke the deputy, and the ex-deputy immediately loses the coverage.
 */
describe('Operations Admin deputy (e2e, RBAC)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let campusId: string;
  let ownerCookies: string[];
  let ownerUserId: string;
  let deputyId: string;   // appointed OPERATIONS_ADMIN
  let deputy2Id: string;  // a second OPERATIONS_ADMIN (peer)
  let lowerId: string;    // a plain teacher the deputy manages

  const sub = `ops-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@ops.pk', password: 'Owner!Secret12' };
  const deputy = { email: 'deputy@ops.pk', password: 'Deputy!Secret12' };
  const deputy2 = { email: 'deputy2@ops.pk', password: 'Deputy!Secret12' };
  const lower = { email: 'lower@ops.pk', password: 'Lower!Secret123' };

  const server = () => app.getHttpServer();
  const login = async (email: string, password: string) => {
    const res = await loginRequest(server(), host, email, password);
    return { status: res.status, cookies: res.headers['set-cookie'] as unknown as string[] };
  };
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const DUMMY = '00000000-0000-0000-0000-000000000000';
  const send = (method: 'post' | 'patch' | 'delete' | 'put', p: string, b: object, cookies: string[]) =>
    request(server())[method](p).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrfOf(cookies)).send(b);
  const get = (p: string, cookies: string[]) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const provisioning = app.get(ProvisioningService, { strict: false });
    const prov = await provisioning.provisionSchool({ name: 'Ops School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password });
    schoolId = prov.schoolId;
    campusId = prov.campusId;

    // Enrolled: granting access and resetting passwords are two-factor gated (see support/mfa.ts).
    ownerCookies = await enrolMfa(server(), host, (await login(owner.email, owner.password)).cookies);
    ownerUserId = (await get('/api/v1/auth/me', ownerCookies)).body.id;

    // Three ordinary teachers on the one campus. Two will be promoted to deputy; one stays lower.
    deputyId = (await send('post', '/api/v1/users', { email: deputy.email, roles: ['TEACHER'], campusId, password: deputy.password }, ownerCookies)).body.id;
    deputy2Id = (await send('post', '/api/v1/users', { email: deputy2.email, roles: ['TEACHER'], campusId, password: deputy2.password }, ownerCookies)).body.id;
    lowerId = (await send('post', '/api/v1/users', { email: lower.email, roles: ['TEACHER'], campusId, password: lower.password }, ownerCookies)).body.id;
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('a plain teacher cannot list users; once the owner appoints them Ops Admin, they can', async () => {
    // Before: a teacher is not an admin.
    const before = (await login(deputy.email, deputy.password)).cookies;
    expect((await get('/api/v1/users', before)).status).toBe(403);

    // Owner appoints the deputy — the account is reused, TEACHER preserved + OPERATIONS_ADMIN added.
    const grant = await send('patch', `/api/v1/users/${deputyId}/access`, { role: 'OPERATIONS_ADMIN', grant: true }, ownerCookies);
    expect(grant.status).toBe(200);
    expect(grant.body.roles).toEqual(expect.arrayContaining(['TEACHER', 'OPERATIONS_ADMIN']));

    // After: a fresh session for the same person now carries the deputy's reach.
    const after = (await login(deputy.email, deputy.password)).cookies;
    expect((await get('/api/v1/users', after)).status).toBe(200);

    // ⚠️ Enrol the deputy NOW, before the OP-1/OP-2 cases below. They expect 403 from the grant
    // CEILING. An unenrolled deputy would be refused by the two-factor guard first — same status, so
    // those cases would keep passing while no longer testing the ceiling at all. Every later deputy
    // sign-in in this file completes the challenge through support/login.ts.
    const enrolled = await enrolMfa(server(), host, after);
    expect((await get('/api/v1/auth/me', enrolled)).body.mfaEnabled).toBe(true);
  });

  it('the deputy does a campus-admin operational job: creates lower staff and grants lower access', async () => {
    const dep = (await login(deputy.email, deputy.password)).cookies;

    // Create a lower-role user (a plain staff member) — allowed for a deputy.
    const created = await send('post', '/api/v1/users', { email: `staff-${Date.now()}@ops.pk`, roles: ['STAFF'], campusId, password: 'Staff!Secret123' }, dep);
    expect(created.status).toBe(201);

    // Grant a lower access role (HR) on an existing teacher — allowed for a deputy.
    const grant = await send('patch', `/api/v1/users/${lowerId}/access`, { role: 'HR_MANAGER', grant: true }, dep);
    expect(grant.status).toBe(200);
    expect(grant.body.roles).toEqual(expect.arrayContaining(['TEACHER', 'HR_MANAGER']));
  });

  it('OP-1: the deputy cannot appoint another deputy — grant or create OPERATIONS_ADMIN → 403', async () => {
    const dep = (await login(deputy.email, deputy.password)).cookies;
    expect((await send('patch', `/api/v1/users/${lowerId}/access`, { role: 'OPERATIONS_ADMIN', grant: true }, dep)).status).toBe(403);
    expect((await send('post', '/api/v1/users', { email: `x-${Date.now()}@ops.pk`, roles: ['OPERATIONS_ADMIN'], password: 'Xx!Secret1234' }, dep)).status).toBe(403);
  });

  it('OP-2: the deputy cannot touch the OWNER — update or reset-password → 403', async () => {
    const dep = (await login(deputy.email, deputy.password)).cookies;
    expect((await send('patch', `/api/v1/users/${ownerUserId}`, { status: 'DISABLED' }, dep)).status).toBe(403);
    expect((await send('post', `/api/v1/users/${ownerUserId}/reset-password`, { password: 'Pwn!Secret1234' }, dep)).status).toBe(403);
  });

  it('OP-2: the deputy cannot touch ANOTHER deputy — grant, reset-password or revoke ops → 403', async () => {
    // One Ops Admin per campus (a seat): a second on the SAME campus is refused …
    expect((await send('patch', `/api/v1/users/${deputy2Id}/access`, { role: 'OPERATIONS_ADMIN', grant: true }, ownerCookies)).status).toBe(409);
    // … so the peer lives on another campus; the owner appoints them there.
    const campus2 = await platform.campus.create({ data: { schoolId, name: 'Second Campus' } });
    await platform.user.update({ where: { id: deputy2Id }, data: { campusId: campus2.id } });
    expect((await send('patch', `/api/v1/users/${deputy2Id}/access`, { role: 'OPERATIONS_ADMIN', grant: true }, ownerCookies)).status).toBe(200);

    // Another campus's people are out of reach for this deputy (403) — a peer's login is never theirs to touch.
    const dep = (await login(deputy.email, deputy.password)).cookies;
    expect((await send('patch', `/api/v1/users/${deputy2Id}/access`, { role: 'HR_MANAGER', grant: true }, dep)).status).toBe(403);
    expect((await send('post', `/api/v1/users/${deputy2Id}/reset-password`, { password: 'Pwn!Secret1234' }, dep)).status).toBe(403);
    // Only the owner may revoke a deputy — a peer cannot.
    expect((await send('patch', `/api/v1/users/${deputy2Id}/access`, { role: 'OPERATIONS_ADMIN', grant: false }, dep)).status).toBe(403);
  });

  it('the Ops Admin is a per-campus seat: no campus-less one, and the deputy sees only their own campus', async () => {
    // A campus is required — the owner cannot mint a school-wide Ops Admin any more.
    const res = await send('post', '/api/v1/users', { email: `nocampus-${Date.now()}@ops.pk`, roles: ['OPERATIONS_ADMIN'], password: 'Xx!Secret1234' }, ownerCookies);
    expect(res.status).toBe(422);

    // Both Ops Admins (campus 1 and campus 2) exist; each sees only their own campus's people.
    const dep = (await login(deputy.email, deputy.password)).cookies;
    const ids = ((await get('/api/v1/users', dep)).body as Array<{ id: string }>).map((u) => u.id);
    expect(ids).toContain(lowerId);
    expect(ids).not.toContain(deputy2Id);
    // And the owner, who is school-wide, sees both.
    const all = ((await get('/api/v1/users', ownerCookies)).body as Array<{ id: string }>).map((u) => u.id);
    expect(all).toEqual(expect.arrayContaining([deputyId, deputy2Id]));
  });

  it('owner-only roots of trust stay owner-only for the deputy: module access + remove → 403', async () => {
    const dep = (await login(deputy.email, deputy.password)).cookies;
    expect((await send('patch', `/api/v1/users/${lowerId}/modules`, { moduleKey: 'recruitment.hire', allowed: false }, dep)).status).toBe(403);
    expect((await send('delete', `/api/v1/users/${lowerId}`, {}, dep)).status).toBe(403);
  });

  // Issues 1 & 2 (QA run 2026-08-29): the deputy's remit was narrower than the plan (§3, D-B) — every
  // OWNER-only route was denied. These operational routes are now OWNER_ADMIN + OPERATIONS_ADMIN.
  it('the deputy can run finance + setup on the owner\'s behalf — the operational OWNER-only routes are now open (not 403)', async () => {
    const dep = (await login(deputy.email, deputy.password)).cookies;
    // "not 403" == authorized (reached the handler/validation). Dummy ids -> 404/400; empty body -> 400.
    const opened: [Parameters<typeof send>[0], string, object][] = [
      ['post', `/api/v1/fees/invoices/${DUMMY}/waive`, { reason: 'qa' }],      // D-B waiver
      ['post', `/api/v1/fees/payments/${DUMMY}/reversals`, { reason: 'qa' }],  // D-B reversal
      ['post', '/api/v1/fee-heads', {}],                                        // fee setup
      ['post', '/api/v1/fee-structures', {}],
      ['patch', '/api/v1/school-settings', {}],
      ['post', '/api/v1/academic-years', {}],
      ['put', '/api/v1/grade-scales', {}],                                      // exam setup
      ['post', '/api/v1/terms', {}],
      ['put', '/api/v1/sms/templates', {}],                                     // comms config
      ['put', `/api/v1/admission-officers/${DUMMY}`, { userId: DUMMY }],        // staff the admission seat
      ['post', '/api/v1/fees/jobs/mark-overdue', {}],                           // defaulters sweep
    ];
    for (const [m, p, b] of opened) {
      const status = (await send(m, p, b, dep)).status;
      expect(status).not.toBe(403);
    }
    // Campus create/close and the cross-campus comparison are the OWNER's: a campus's Ops Admin runs one campus.
    expect((await send('post', '/api/v1/campuses', { name: 'Ops Campus' }, dep)).status).toBe(403);
    expect((await get('/api/v1/campuses/summary', dep)).status).toBe(403);
    // The campus list shows them only their own campus.
    expect(((await get('/api/v1/campuses', dep)).body as Array<{ id: string }>).map((c) => c.id)).toEqual([campusId]);
    // Still owner-reserved: integrity-check is a diagnostic, deliberately NOT opened to the deputy.
    expect((await get('/api/v1/fees/integrity-check', dep)).status).toBe(403);
  });

  it('school-wide setup: the Ops Admin PROPOSES, nothing changes until the owner approves; the owner acts directly', async () => {
    const dep = (await login(deputy.email, deputy.password)).cookies;
    const heads = async (cookies: string[]) => ((await get('/api/v1/fee-heads', cookies)).body as Array<{ id: string; name: string }>);

    // The Ops Admin asks for a new fee head → accepted as a proposal, NOT created.
    const asked = await send('post', '/api/v1/fee-heads', { name: 'Lab fee' }, dep);
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({ pendingApproval: true });
    expect(asked.headers['x-pending-approval']).toBe(asked.body.approvalId);
    expect((await heads(ownerCookies)).map((h) => h.name)).not.toContain('Lab fee');

    // A setting change is a proposal too — including from a DELETE (no body), signalled by the header.
    const setting = await send('patch', '/api/v1/school-settings', { feeDueDay: 12 }, dep);
    expect(setting.body).toMatchObject({ pendingApproval: true });
    expect((await get('/api/v1/school-settings', ownerCookies)).body.feeDueDay).not.toBe(12);

    // The owner sees both, with the change spelled out in the proposer's own words.
    const open = (await get('/api/v1/approvals?status=PENDING', ownerCookies)).body as Array<{ id: string; type: string; title: string; changes: Array<{ label: string; value: string }> | null; requestedBy: string }>;
    const headReq = open.find((r) => r.title === 'Add fee head “Lab fee”')!;
    expect(headReq).toMatchObject({ type: 'SETUP_CHANGE' });
    expect(headReq.changes).toEqual([{ label: 'Name', value: 'Lab fee' }]);
    // The deputy can follow their own request but cannot decide it.
    expect((await get('/api/v1/approvals?status=PENDING', dep)).body.length).toBeGreaterThanOrEqual(2);
    expect((await send('post', `/api/v1/approvals/${headReq.id}/approve`, {}, dep)).status).toBe(403);

    // Approve → the SAME executor runs, as the owner: the fee head now exists.
    expect((await send('post', `/api/v1/approvals/${headReq.id}/approve`, {}, ownerCookies)).status).toBe(201);
    const created = (await heads(ownerCookies)).find((h) => h.name === 'Lab fee');
    expect(created).toBeDefined();
    // Reject → nothing ever happens.
    const settingReq = open.find((r) => r.title.startsWith('Change school settings'))!;
    expect((await send('post', `/api/v1/approvals/${settingReq.id}/reject`, { reason: 'Keep the 5th' }, ownerCookies)).status).toBe(201);
    expect((await get('/api/v1/school-settings', ownerCookies)).body.feeDueDay).not.toBe(12);

    // A DELETE (204, no body) is still a proposal; the owner removing it directly just works.
    const del = await send('delete', `/api/v1/fee-heads/${created!.id}`, {}, dep);
    expect(del.status).toBe(204);
    expect(del.headers['x-pending-approval']).toBeTruthy();
    expect((await heads(ownerCookies)).map((h) => h.name)).toContain('Lab fee');
    expect((await send('delete', `/api/v1/fee-heads/${created!.id}`, {}, ownerCookies)).status).toBe(204);
    expect((await heads(ownerCookies)).map((h) => h.name)).not.toContain('Lab fee');
  });

  it('the owner revokes the deputy, and the ex-deputy immediately loses the reach', async () => {
    const revoke = await send('patch', `/api/v1/users/${deputyId}/access`, { role: 'OPERATIONS_ADMIN', grant: false }, ownerCookies);
    expect(revoke.status).toBe(200);
    expect(revoke.body.roles).toEqual(['TEACHER']);

    const after = (await login(deputy.email, deputy.password)).cookies;
    expect((await get('/api/v1/users', after)).status).toBe(403);
  });

  it('writes an audit trail for the appointment and the revocation', async () => {
    const actions = (await platform.auditLog.findMany({ where: { schoolId, entityId: deputyId } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['ROLE_ACCESS_GRANTED', 'ROLE_ACCESS_REVOKED']));
  });
});
