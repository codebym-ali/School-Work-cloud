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
import { loginRequest } from './support/login';

/**
 * "What changed for me" (Notifications Plan, N0).
 *
 * The property under test is not "a notice appears" — it is that **notices are derived, never
 * stored**. Anything can make a row show up once; what matters here is that it *stops* showing up
 * when its cause goes away, because that is the whole reason there is no notifications table. A
 * suite that only asserts appearance would pass equally well against the stored design this
 * deliberately rejected.
 */
describe('Notifications — derived, self-scoped (e2e, N0)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let campusId: string;
  let ownerCookies: string[];
  let ownerCsrf: string;
  let teacherCookies: string[];
  let staffId: string;
  let otherStaffId: string;

  const sub = `ntf-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@ntf.pk', password: 'Owner!Secret12' };
  const teacher = { email: 'teacher@ntf.pk', password: 'Teach!Secret12' };
  // No password and no session: proving the feed filters by staff profile does not need a second
  // login, and each argon2 hash is a real slice of the 30s hook budget every spec shares.
  const other = { email: 'other@ntf.pk' };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object = {}) =>
    request(server()).post(p).set('Host', host).set('Cookie', ownerCookies).set('X-CSRF-Token', ownerCsrf).send(b);
  const login = async (e: string, pw: string) => {
    const res = await loginRequest(server(), host, e, pw);
    return res.headers['set-cookie'] as unknown as string[];
  };
  const notify = async (cookies: string[]) => {
    const res = await request(server()).get('/api/v1/notifications').set('Host', host).set('Cookie', cookies);
    expect(res.status).toBe(200);
    return res.body.items as Array<{ id: string; kind: string; text: string; href: string; at: string }>;
  };
  const kinds = async (cookies: string[]) => (await notify(cookies)).map((i) => i.kind);

  /** Inside the seeded year and behind today, so leave dates are always decidable. */
  const PAST = '2026-07';

  /**
   * A recent past working day — **not** `PAST`, and the difference matters.
   *
   * The absence notice only looks back 7 days: beyond that a marked absence is history, not news,
   * and cannot still be disputed before payday. A date in `PAST` is months old, so it is correctly
   * invisible and a test using it would be asserting against a window it had fallen out of.
   * Yesterday, skipping Sunday (the default weekly off), is always both markable and recent.
   */
  const recentWorkingDay = (): string => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1); // never today or later — the register refuses the future
    while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const prov = await app.get(ProvisioningService, { strict: false }).provisionSchool({
      name: 'Ntf School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password,
    });
    schoolId = prov.schoolId;
    campusId = prov.campusId;

    ownerCookies = await login(owner.email, owner.password);
    ownerCsrf = csrfOf(ownerCookies);
    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });

    const mk = async (email: string, code: string, password?: string) => {
      const res = await post('/api/v1/staff', {
        email, campusId, staffType: 'TEACHER', employeeCode: code,
        designation: 'Teacher', joinedAt: '2026-04-01', fullName: `T ${code}`,
      });
      expect(res.status).toBe(201);
      const id = res.body.staffId as string;
      if (password) {
        const profile = await platform.staffProfile.findFirstOrThrow({ where: { id }, select: { userId: true } });
        await platform.user.update({
          where: { id: profile.userId! },
          data: { passwordHash: await argon2.hash(password, { type: argon2.argon2id }), roles: ['TEACHER'] as never, status: 'ACTIVE' },
        });
      }
      return id;
    };
    staffId = await mk(teacher.email, 'EMP-001', teacher.password);
    otherStaffId = await mk(other.email, 'EMP-002');
    teacherCookies = await login(teacher.email, teacher.password);
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  afterEach(async () => {
    await platform.staffLeave.deleteMany({ where: { schoolId } });
    await platform.staffAttendance.deleteMany({ where: { schoolId } });
    // Unread is per-user state that outlives a test. Reset it, so no case depends on running
    // after the one that happened to stamp it — order-dependent tests pass until someone
    // reorders them and then fail for a reason that has nothing to do with the change.
    await platform.user.updateMany({ where: { schoolId }, data: { notificationsSeenAt: null } });
  });

  it('says nothing when nothing has happened', async () => {
    expect(await notify(teacherCookies)).toEqual([]);
  });

  it('tells a teacher their leave was approved', async () => {
    const leave = await post('/api/v1/staff-leaves', {
      staffId, leaveType: 'CASUAL', fromDate: `${PAST}-06`, toDate: `${PAST}-07`, reason: 'Wedding',
    });
    await post(`/api/v1/staff-leaves/${leave.body.id}/approve`);

    const items = await notify(teacherCookies);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('LEAVE_DECIDED');
    expect(items[0].text).toContain('approved');
    expect(items[0].href).toBe('/my-leaves');
  });

  it('carries the rejection reason, which is the whole point of requiring one', async () => {
    const leave = await post('/api/v1/staff-leaves', {
      staffId, leaveType: 'CASUAL', fromDate: `${PAST}-06`, toDate: `${PAST}-06`, reason: 'Personal',
    });
    await post(`/api/v1/staff-leaves/${leave.body.id}/reject`, { reason: 'Exams that week' });

    const items = await notify(teacherCookies);
    // The office is forced to type a reason; leaving it on a row the person must go and find is
    // what made that requirement pointless.
    expect(items[0].text).toContain('Exams that week');
  });

  it('stops saying it once the cause is gone — the reason there is no notifications table', async () => {
    const leave = await post('/api/v1/staff-leaves', {
      staffId, leaveType: 'CASUAL', fromDate: `${PAST}-06`, toDate: `${PAST}-06`, reason: 'Personal',
    });
    await post(`/api/v1/staff-leaves/${leave.body.id}/approve`);
    expect(await kinds(teacherCookies)).toContain('LEAVE_DECIDED');

    // Delete the leave outright — the strongest form of "its cause went away". A stored notice
    // would survive this and go on telling someone about a leave that no longer exists.
    await platform.staffLeave.delete({ where: { id: leave.body.id } });
    expect(await kinds(teacherCookies)).not.toContain('LEAVE_DECIDED');
  });

  it('warns about an absence, because that is how a wrong one gets corrected before payday', async () => {
    const day = recentWorkingDay();
    await post('/api/v1/staff-attendance/bulk', {
      date: day, session: 'MORNING', records: [{ staffId, status: 'ABSENT' }],
    });
    const items = await notify(teacherCookies);
    expect(items.map((i) => i.kind)).toContain('MARKED_ABSENT');
    expect(items.find((i) => i.kind === 'MARKED_ABSENT')!.href).toBe('/my-attendance');
  });

  it('says nothing about an absence too old to dispute', async () => {
    // Months back. Still on the register, still deducted long ago — but telling someone now is
    // noise, and a feed that never forgets is a feed nobody opens.
    await post('/api/v1/staff-attendance/bulk', {
      date: `${PAST}-06`, session: 'MORNING', records: [{ staffId, status: 'ABSENT' }],
    });
    expect(await kinds(teacherCookies)).not.toContain('MARKED_ABSENT');
  });

  it('drops the absence notice when the office corrects it to ON_LEAVE', async () => {
    const day = recentWorkingDay();
    await post('/api/v1/staff-attendance/bulk', {
      date: day, session: 'MORNING', records: [{ staffId, status: 'ABSENT' }],
    });
    expect(await kinds(teacherCookies)).toContain('MARKED_ABSENT');

    // Exactly what approving a backdated leave does (L4). The notice must follow the record.
    const leave = await post('/api/v1/staff-leaves', {
      staffId, leaveType: 'SICK', fromDate: day, toDate: day, reason: 'Medical certificate',
    });
    await post(`/api/v1/staff-leaves/${leave.body.id}/approve`);

    const after = await kinds(teacherCookies);
    expect(after).not.toContain('MARKED_ABSENT'); // it is ON_LEAVE now — the system agrees with them
    expect(after).toContain('LEAVE_DECIDED');
  });

  it('never shows one person another person\'s notices', async () => {
    // A colleague's leave is decided the same day, in the same school, by the same admin.
    const theirs = await post('/api/v1/staff-leaves', {
      staffId: otherStaffId, leaveType: 'CASUAL', fromDate: `${PAST}-06`, toDate: `${PAST}-06`, reason: 'Not yours',
    });
    await post(`/api/v1/staff-leaves/${theirs.body.id}/approve`);
    const mine = await post('/api/v1/staff-leaves', {
      staffId, leaveType: 'CASUAL', fromDate: `${PAST}-13`, toDate: `${PAST}-13`, reason: 'Mine alone',
    });
    await post(`/api/v1/staff-leaves/${mine.body.id}/approve`);

    const items = await notify(teacherCookies);
    // Exactly one, and it is theirs. The request carries no staffId at all — the gate is
    // ownership, not role, so there is no parameter a caller could change to reach across.
    expect(items).toHaveLength(1);
    expect(items[0].id).toContain(mine.body.id);
    expect(items.some((i) => i.id.includes(theirs.body.id))).toBe(false);
  });

  // ── unread, from one column rather than a table (N1) ──────────────────────
  it('counts everything as new until the person has looked', async () => {
    const leave = await post('/api/v1/staff-leaves', {
      staffId, leaveType: 'CASUAL', fromDate: `${PAST}-06`, toDate: `${PAST}-06`, reason: 'Personal',
    });
    await post(`/api/v1/staff-leaves/${leave.body.id}/approve`);

    const res = await request(server()).get('/api/v1/notifications').set('Host', host).set('Cookie', teacherCookies);
    // `notificationsSeenAt` is null — never opened — which correctly makes everything new.
    expect(res.body.unread).toBe(1);
    expect(res.body.items[0].isNew).toBe(true);
  });

  it('stops counting them once they have been seen, and the count matches the list', async () => {
    const leave = await post('/api/v1/staff-leaves', {
      staffId, leaveType: 'CASUAL', fromDate: `${PAST}-06`, toDate: `${PAST}-06`, reason: 'Personal',
    });
    await post(`/api/v1/staff-leaves/${leave.body.id}/approve`);

    const csrf = csrfOf(teacherCookies);
    const seen = await request(server()).post('/api/v1/notifications/seen')
      .set('Host', host).set('Cookie', teacherCookies).set('X-CSRF-Token', csrf).send({});
    expect(seen.status).toBe(201);

    const after = await request(server()).get('/api/v1/notifications').set('Host', host).set('Cookie', teacherCookies);
    expect(after.body.unread).toBe(0);
    // The item is still THERE — it is read, not deleted. A feed that empties itself on a glance
    // cannot answer "what was that about?" ten minutes later.
    expect(after.body.items).toHaveLength(1);
    expect(after.body.items[0].isNew).toBe(false);
    // A bell reading 3 that opens onto 2 items is worse than no bell.
    expect(after.body.unread).toBe(after.body.items.filter((i: { isNew: boolean }) => i.isNew).length);
  });

  it('makes something that happens AFTER the visit new again', async () => {
    const csrf = csrfOf(teacherCookies);
    await request(server()).post('/api/v1/notifications/seen')
      .set('Host', host).set('Cookie', teacherCookies).set('X-CSRF-Token', csrf).send({});

    const leave = await post('/api/v1/staff-leaves', {
      staffId, leaveType: 'CASUAL', fromDate: `${PAST}-06`, toDate: `${PAST}-06`, reason: 'After the visit',
    });
    await post(`/api/v1/staff-leaves/${leave.body.id}/approve`);

    const res = await request(server()).get('/api/v1/notifications').set('Host', host).set('Cookie', teacherCookies);
    // Decided after the stamp — so marking seen must not have silenced future notices too.
    expect(res.body.unread).toBe(1);
  });

  it('records the visit against the caller and nobody else', async () => {
    const csrf = csrfOf(teacherCookies);
    await request(server()).post('/api/v1/notifications/seen')
      .set('Host', host).set('Cookie', teacherCookies).set('X-CSRF-Token', csrf).send({});

    // There is no id in the path or body, so there is nothing to point at another account — and
    // the other staff member's stamp is untouched.
    const other = await platform.staffProfile.findFirstOrThrow({ where: { id: otherStaffId }, select: { user: { select: { notificationsSeenAt: true } } } });
    expect(other.user?.notificationsSeenAt).toBeNull();
  });

  // ── "what the school needs from you" (N2) ─────────────────────────────────
  /** Every kind that is about the SCHOOL rather than about you. */
  const SCHOOL_KINDS = [
    'DEFAULTERS', 'LEAVES_PENDING', 'SMS_FAILED', 'CLAIMS_PENDING',
    'REGISTERS_UNMARKED', 'STAFF_UNMARKED', 'STAFF_ABSENT', 'READY_TO_ADMIT', 'TESTS_TODAY',
  ];

  it('tells an admin what the school needs from them', async () => {
    // A pending leave is the cheapest school-wide fact to create, and it is one an owner acts on.
    await post('/api/v1/staff-leaves', {
      staffId, leaveType: 'CASUAL', fromDate: `${PAST}-06`, toDate: `${PAST}-06`, reason: 'Waiting',
    });
    const res = await request(server()).get('/api/v1/notifications').set('Host', host).set('Cookie', ownerCookies);
    expect(res.status).toBe(200);
    // The owner has no staff profile, so this cannot be a personal item — it is the school's.
    const kinds = res.body.items.map((i: { kind: string }) => i.kind);
    expect(kinds).toContain('LEAVES_PENDING');
  });

  it('gives a TEACHER none of the school-wide figures', async () => {
    // ⚠️ The load-bearing test for N2. The services behind those items are called DIRECTLY, so
    // the `@Roles` decorators on their controllers never run — the gates are restated by hand in
    // `NEEDS`, and a mistake there hands one teacher the whole school's defaulters, failed SMS
    // and payment queue. Appearing in the bell would be a silent leak with no error anywhere.
    await post('/api/v1/staff-leaves', {
      staffId, leaveType: 'CASUAL', fromDate: `${PAST}-06`, toDate: `${PAST}-06`, reason: 'Waiting',
    });
    const items = await notify(teacherCookies);
    for (const kind of SCHOOL_KINDS) {
      expect(items.map((i) => i.kind)).not.toContain(kind);
    }
  });

  it('answers an account with no staff profile without a 403, and gives it no personal items', async () => {
    // The app shell calls this on every page for every signed-in user, so an account with no
    // staff profile must get an answer rather than an error that breaks the page around it.
    //
    // Note this asserts NO PERSONAL ITEMS rather than an empty list: since N2 the owner
    // legitimately receives the school's own items, and demanding `[]` here would have been a
    // test that only passed while the feature was half-built.
    const res = await request(server()).get('/api/v1/notifications').set('Host', host).set('Cookie', ownerCookies);
    expect(res.status).toBe(200);
    const personal = ['LEAVE_DECIDED', 'MARKED_ABSENT', 'SALARY_PAID', 'REGISTER_UNMARKED'];
    for (const kind of personal) {
      expect(res.body.items.map((i: { kind: string }) => i.kind)).not.toContain(kind);
    }
  });
});
