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
 * Staff & teacher leave (§10) — the rules that decide **pay**.
 *
 * `leaves.e2e-spec` covers the student half; the staff half had no test at all, which is the
 * wrong way round: a student leave moves an attendance row, a staff leave moves a salary. Every
 * case here is one of those, and each failed before the 2026-08-07 rework:
 *
 *  - leave of type UNPAID was recorded as PAID (the quota map has no UNPAID key, and "no quota"
 *    short-circuited to paid) — the one type whose name says it cuts pay was the one that did not;
 *  - the quota counted REQUESTS, so ten separate one-day casual leaves hit a 10-day limit while a
 *    single 15-day leave sailed under it;
 *  - the quota had no year window, so it counted every approved leave since the school opened;
 *  - a weekly off inside a leave was charged as a leave day, at a rate whose divisor excludes it;
 *  - approving changed nothing a payslip could see: a day already marked ABSENT stayed ABSENT.
 */
describe('Staff leave — quota, pay and the register (e2e, §10)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let campusId: string;
  let ownerCookies: string[];
  let ownerCsrf: string;
  let teacherCookies: string[];
  let teacherCsrf: string;
  let staffId: string;
  let otherStaffId: string;

  const sub = `slv-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@slv.pk', password: 'Owner!Secret12' };
  const teacher = { email: 'teacher@slv.pk', password: 'Teach!Secret12' };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const authed = (m: 'get' | 'post' | 'patch', p: string, c: string[], csrf?: string) => {
    let r = request(server())[m](p).set('Host', host).set('Cookie', c);
    if (csrf) r = r.set('X-CSRF-Token', csrf);
    return r;
  };
  const post = (p: string, b: object = {}) => authed('post', p, ownerCookies, ownerCsrf).send(b);
  const get = (p: string) => authed('get', p, ownerCookies);
  const login = async (e: string, pw: string) => {
    const res = await loginRequest(server(), host, e, pw);
    return res.headers['set-cookie'] as unknown as string[];
  };

  const file = (b: object) => post('/api/v1/staff-leaves', b);
  const balance = (qs = '') => get(`/api/v1/staff-leaves/balance${qs}`);
  const approve = (id: string) => post(`/api/v1/staff-leaves/${id}/approve`);

  /**
   * Two different months, and the difference matters.
   *
   * `IN_YEAR` is ahead of today: leave is normally *requested* in advance, and these cases only
   * exercise the quota. `PAST` is behind today because **attendance cannot be marked in the
   * future** — the register refuses it — so any case that first marks a day and then approves
   * leave over it has to sit in a month that has already happened. Both are inside the seeded
   * academic year (2026-04-01 → 2027-03-31), or the quota window would exclude them.
   *
   * 2026-09-07 and 2026-07-06 are both Mondays, so `-07`/`-08` and `-06`/`-07` are working days
   * under the default SUNDAY weekly off.
   */
  const IN_YEAR = '2026-09';
  const PAST = '2026-07';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const prov = await app.get(ProvisioningService, { strict: false }).provisionSchool({
      name: 'Slv School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password,
    });
    schoolId = prov.schoolId;
    campusId = prov.campusId;

    ownerCookies = await login(owner.email, owner.password);
    ownerCsrf = csrfOf(ownerCookies);

    await post('/api/v1/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    // A small quota makes the day-vs-request distinction visible in three leaves rather than ten.
    await authed('patch', '/api/v1/school-settings', ownerCookies, ownerCsrf).send({ staffLeaveQuotas: { CASUAL: 3, SICK: 8 } });

    const mk = async (email: string) => {
      const res = await post('/api/v1/staff', {
        email, campusId, staffType: 'TEACHER', employeeCode: `EMP-${randomUUID().slice(0, 6)}`,
        designation: 'Teacher', joinedAt: '2026-04-01', fullName: `T ${email.split('@')[0]}`,
      });
      expect(res.status).toBe(201);
      return res.body.staffId as string;
    };
    staffId = await mk(teacher.email);
    otherStaffId = await mk('other@slv.pk');

    // Give the teacher a password so the self-scoping cases run as a real TEACHER session rather
    // than as an admin pretending to be one.
    await platform.user.update({
      where: { id: (await platform.staffProfile.findFirstOrThrow({ where: { id: staffId }, select: { userId: true } })).userId! },
      data: { passwordHash: await argon2.hash(teacher.password, { type: argon2.argon2id }), roles: ['TEACHER'] as never, status: 'ACTIVE' },
    });
    teacherCookies = await login(teacher.email, teacher.password);
    teacherCsrf = csrfOf(teacherCookies);
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  afterEach(async () => {
    await platform.staffLeave.deleteMany({ where: { schoolId } });
    await platform.staffAttendance.deleteMany({ where: { schoolId } });
  });

  // ── the type whose name is the rule ────────────────────────────────────────
  it('records leave of type UNPAID as unpaid', async () => {
    const res = await file({ staffId, leaveType: 'UNPAID', fromDate: `${IN_YEAR}-07`, toDate: `${IN_YEAR}-08`, reason: 'Personal' });
    expect(res.status).toBe(201);
    // Was `false`: the quota map has no UNPAID key, and an unconfigured type meant "no limit,
    // paid". Approved unpaid leave is deducted whatever the school's absence setting says (G5),
    // so this flag is the whole difference between the label and the money.
    expect(res.body.isUnpaid).toBe(true);
  });

  it('leaves a type the school has set no quota for as paid, and says so rather than showing zero', async () => {
    const res = await file({ staffId, leaveType: 'OTHER', fromDate: `${IN_YEAR}-07`, toDate: `${IN_YEAR}-07`, reason: 'Court summons' });
    expect(res.body.isUnpaid).toBe(false);
    // "Unset" must not render as "none left" — reading it that way would turn every OTHER leave
    // unpaid the day this shipped, which is a pay cut delivered by an upgrade.
    const b = await balance(`?staffId=${staffId}`);
    const other = b.body.balances.find((x: { leaveType: string }) => x.leaveType === 'OTHER');
    expect(other.entitlementDays).toBeNull();
    expect(other.remainingDays).toBeNull();
  });

  // ── the quota counts days, over a year ─────────────────────────────────────
  it('counts quota in DAYS, not in requests', async () => {
    // 2026-09-07 is a Monday; Mon–Tue is 2 working days and inside the 3-day CASUAL quota.
    const first = await file({ staffId, leaveType: 'CASUAL', fromDate: `${IN_YEAR}-07`, toDate: `${IN_YEAR}-08`, reason: 'A' });
    expect(first.body.isUnpaid).toBe(false);
    expect((await approve(first.body.id)).body.isUnpaid).toBe(false);

    // One more request — the OLD code saw a single approved request against a quota of 3 and
    // called it paid. In days, 2 are already spent and 2 more overshoots.
    const second = await file({ staffId, leaveType: 'CASUAL', fromDate: `${IN_YEAR}-14`, toDate: `${IN_YEAR}-15`, reason: 'B' });
    expect(second.body.isUnpaid).toBe(true);
  });

  it('does not charge a weekly off as a leave day', async () => {
    // Fri 2026-09-11 → Mon 2026-09-14 spans a Sunday: 4 calendar days, 3 working ones.
    const b = await balance(`?staffId=${staffId}&leaveType=CASUAL&fromDate=${IN_YEAR}-11&toDate=${IN_YEAR}-14`);
    expect(b.body.proposed.workingDays).toBe(3);
    // Charging the Sunday would also have deducted it at basic/workingDays — a rate whose
    // denominator already excludes Sundays.
  });

  it('re-decides paid/unpaid at APPROVE, so entitlement is consumed in approval order', async () => {
    const a = await file({ staffId, leaveType: 'CASUAL', fromDate: `${IN_YEAR}-07`, toDate: `${IN_YEAR}-09`, reason: 'A' }); // 3 days
    const b = await file({ staffId, leaveType: 'CASUAL', fromDate: `${IN_YEAR}-14`, toDate: `${IN_YEAR}-14`, reason: 'B' }); // 1 day
    // Both were filed while nothing was approved, so both were stamped PAID at create.
    expect(a.body.isUnpaid).toBe(false);
    expect(b.body.isUnpaid).toBe(false);

    expect((await approve(a.body.id)).body.isUnpaid).toBe(false); // takes all 3
    // B is approved second and there is nothing left — a stamp from create time would have
    // carried a stale answer straight into someone's salary.
    expect((await approve(b.body.id)).body.isUnpaid).toBe(true);
  });

  // ── the balance is readable before it is applied ───────────────────────────
  it('reports entitlement, used, pending and remaining for the current academic year', async () => {
    const approved = await file({ staffId, leaveType: 'CASUAL', fromDate: `${IN_YEAR}-07`, toDate: `${IN_YEAR}-08`, reason: 'Used' });
    await approve(approved.body.id);
    await file({ staffId, leaveType: 'CASUAL', fromDate: `${IN_YEAR}-21`, toDate: `${IN_YEAR}-21`, reason: 'Waiting' });

    const b = await balance(`?staffId=${staffId}`);
    expect(b.body.windowStart).toBe('2026-04-01');
    expect(b.body.windowEnd).toBe('2027-03-31');
    const casual = b.body.balances.find((x: { leaveType: string }) => x.leaveType === 'CASUAL');
    expect(casual).toMatchObject({ entitlementDays: 3, usedDays: 2, pendingDays: 1, remainingDays: 1 });
  });

  it('does not count a leave from outside the entitlement year', async () => {
    // Before the year began (2026-04-01). The old quota had no window at all, so leaves
    // accumulated for ever and every request eventually became unpaid.
    const old = await file({ staffId, leaveType: 'CASUAL', fromDate: '2026-02-02', toDate: '2026-02-04', reason: 'Last year' });
    await approve(old.body.id);
    const casual = (await balance(`?staffId=${staffId}`)).body.balances.find((x: { leaveType: string }) => x.leaveType === 'CASUAL');
    expect(casual.usedDays).toBe(0);
    expect(casual.remainingDays).toBe(3);
  });

  // ── the balance is the caller's own ────────────────────────────────────────
  it('forces a teacher to their own balance and refuses them somebody else\'s', async () => {
    const mine = await authed('get', `/api/v1/staff-leaves/balance?staffId=${otherStaffId}`, teacherCookies);
    expect(mine.status).toBe(200);
    // Asked about a colleague, answered about themselves — §22.8 self-scoping, the same shape as
    // `/staff-attendance/mine` and `/payslips/mine`.
    expect(mine.body.staffId).toBe(staffId);
    expect(mine.body.staffId).not.toBe(otherStaffId);
  });

  it('lets a teacher file their own leave without naming themselves', async () => {
    const res = await authed('post', '/api/v1/staff-leaves', teacherCookies, teacherCsrf)
      .send({ leaveType: 'SICK', fromDate: `${IN_YEAR}-07`, toDate: `${IN_YEAR}-07`, reason: 'Fever' });
    expect(res.status).toBe(201);
    expect(res.body.staffId).toBe(staffId);
  });

  // ── approving settles the register ─────────────────────────────────────────
  it('corrects a day already marked ABSENT to ON_LEAVE when the leave is approved', async () => {
    const date = `${PAST}-07`;
    const marked = await post('/api/v1/staff-attendance/bulk', {
      date, session: 'MORNING', records: [{ staffId, status: 'ABSENT' }],
    });
    expect(marked.body.succeeded).toBe(1);

    const leave = await file({ staffId, leaveType: 'SICK', fromDate: date, toDate: date, reason: 'Medical certificate' });
    const res = await approve(leave.body.id);
    // The commonest case in a real school: the certificate arrives the morning after. Before
    // this, approving changed nothing payroll could see — `absentDays()` counts ABSENT rows, so
    // the approved sick leave was still deducted as an absence.
    expect(res.body.attendanceCorrected).toBe(1);

    const row = await platform.staffAttendance.findFirstOrThrow({ where: { schoolId, staffId, date: new Date(date) } });
    expect(row.status).toBe('ON_LEAVE');
  });

  it('never overwrites a day the person was actually present', async () => {
    const date = `${PAST}-07`;
    await post('/api/v1/staff-attendance/bulk', { date, session: 'MORNING', records: [{ staffId, status: 'PRESENT' }] });

    const leave = await file({ staffId, leaveType: 'CASUAL', fromDate: date, toDate: `${PAST}-08`, reason: 'Range covers a day worked' });
    expect((await approve(leave.body.id)).body.attendanceCorrected).toBe(0);

    // They came in. An approval covering a range that includes a day they worked must not erase
    // the observation — the register records what happened, not what was authorised.
    const row = await platform.staffAttendance.findFirstOrThrow({ where: { schoolId, staffId, date: new Date(date) } });
    expect(row.status).toBe('PRESENT');
  });

  it('does not fabricate attendance for days nobody recorded', async () => {
    const leave = await file({ staffId, leaveType: 'CASUAL', fromDate: `${PAST}-07`, toDate: `${PAST}-09`, reason: 'Nothing marked' });
    expect((await approve(leave.body.id)).body.attendanceCorrected).toBe(0);
    // "Approved leave" is not evidence about a day, and marking days forward would be marking
    // the future. An unrecorded day stays an honest gap; the day-close job owns writing ON_LEAVE
    // as each day arrives.
    expect(await platform.staffAttendance.count({ where: { schoolId, staffId } })).toBe(0);
  });
});
