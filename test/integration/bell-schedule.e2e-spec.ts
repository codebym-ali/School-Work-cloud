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

/**
 * Bell schedule (the school's own clock).
 *
 * The timetable could always say *what* happens in period 3 and never *when*: `periodNo` was a bare
 * ordinal and the grid guessed a class's period count from `max(periodNo)`, floored at 6. So every
 * case here is new behaviour rather than a regression net, and the ones chosen are the rules that
 * decide whether `periodNo` means one thing across the product — above all **that exactly one
 * schedule can ever resolve for a class**, which is the invariant the whole model rests on.
 */
describe('Bell schedule (e2e)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let campusId: string;
  let farCampusId: string;
  let ownerCookies: string[];
  let ownerCsrf: string;
  let campusAdminCookies: string[];
  let campusAdminCsrf: string;
  let classId: string;
  let sectionA: string;
  let farClassId: string;
  let subjectId: string;
  let staffId: string;

  const sub = `bell-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@bell.pk', password: 'Owner!Secret12' };
  const campusAdmin = { email: 'ca@bell.pk', password: 'Campus!Secret12' };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object = {}) =>
    request(server()).post(p).set('Host', host).set('Cookie', ownerCookies).set('X-CSRF-Token', ownerCsrf).send(b);
  const put = (p: string, b: object = {}) =>
    request(server()).put(p).set('Host', host).set('Cookie', ownerCookies).set('X-CSRF-Token', ownerCsrf).send(b);
  const patch = (p: string, b: object = {}) =>
    request(server()).patch(p).set('Host', host).set('Cookie', ownerCookies).set('X-CSRF-Token', ownerCsrf).send(b);
  const del = (p: string) =>
    request(server()).delete(p).set('Host', host).set('Cookie', ownerCookies).set('X-CSRF-Token', ownerCsrf);
  const get = (p: string, cookies = ownerCookies) => request(server()).get(p).set('Host', host).set('Cookie', cookies);

  const asCampusAdmin = {
    put: (p: string, b: object = {}) =>
      request(server()).put(p).set('Host', host).set('Cookie', campusAdminCookies).set('X-CSRF-Token', campusAdminCsrf).send(b),
    get: (p: string) => request(server()).get(p).set('Host', host).set('Cookie', campusAdminCookies),
  };

  const login = async (e: string, pw: string) => {
    const res = await loginRequest(server(), host, e, pw);
    return res.headers['set-cookie'] as unknown as string[];
  };

  /** A plain full day: assembly, four periods, a break in the middle. */
  const regularDay = {
    startsAt: '08:00',
    rows: [
      { isTeaching: false, label: 'Assembly', minutes: 15 },
      { isTeaching: true, minutes: 40 },
      { isTeaching: true, minutes: 40 },
      { isTeaching: false, label: 'Break', minutes: 15 },
      { isTeaching: true, minutes: 40 },
      { isTeaching: true, minutes: 40 },
    ],
  };

  const mkSchedule = async (body: object) => {
    const res = await post('/api/v1/bell-schedules', body);
    expect(res.status).toBe(201);
    return res.body.id as string;
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
      name: 'Bell School', subdomain: sub, ownerEmail: owner.email, ownerPassword: owner.password,
    });
    schoolId = prov.schoolId;
    campusId = prov.campusId;

    ownerCookies = await login(owner.email, owner.password);
    ownerCsrf = csrfOf(ownerCookies);

    await post('/api/v1/academic-years', {
      name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true,
    });

    classId = (await post('/api/v1/classes', { campusId, name: 'Grade 9', order: 9 })).body.id;
    sectionA = (await post('/api/v1/sections', { classId, name: 'A' })).body.id;

    // A second campus with its own class, so every campus rule has something on the WRONG side of
    // the boundary to catch. A boundary test whose fixture is entirely on one side cannot fail.
    farCampusId = (await post('/api/v1/campuses', { name: 'Far Campus' })).body.id;
    farClassId = (await post('/api/v1/classes', { campusId: farCampusId, name: 'Grade 1', order: 1 })).body.id;

    subjectId = (await post('/api/v1/subjects', { classId, name: 'Mathematics' })).body.id;
    staffId = (await post('/api/v1/staff', {
      email: 'bellteach@bell.pk', campusId, staffType: 'TEACHER', employeeCode: 'BT1',
      designation: 'Teacher', joinedAt: '2026-04-01', fullName: 'Bell Teacher',
    })).body.staffId;

    const ca = await post('/api/v1/users', {
      email: campusAdmin.email, roles: ['CAMPUS_ADMIN'], campusId, password: campusAdmin.password,
    });
    expect(ca.status).toBe(201);
    campusAdminCookies = await login(campusAdmin.email, campusAdmin.password);
    campusAdminCsrf = csrfOf(campusAdminCookies);
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  afterEach(async () => {
    // FK order: lessons reference subjects, subjects are referenced by section_subjects.
    await platform.timetableSlot.deleteMany({ where: { schoolId } });
    await platform.sectionSubject.deleteMany({ where: { schoolId } });
    // ⚠️ The weekly load and the section's subject list are BOTH sticky, and both are read by the
    // load meter — so leaving either behind lets one case decide another one's answer. The
    // "unallocated is not zero" case would read `target: 2` purely because the case above it ran
    // first, and would then pass or fail on test ORDER rather than on behaviour.
    await platform.subject.deleteMany({ where: { schoolId, NOT: { id: subjectId } } });
    await platform.subject.updateMany({ where: { schoolId }, data: { periodsPerWeek: null } });
    await platform.bellScheduleClass.deleteMany({ where: { schoolId } });
    await platform.bellPeriod.deleteMany({ where: { schoolId } });
    await platform.bellSchedule.deleteMany({ where: { schoolId } });
  });

  // ── composing a day ───────────────────────────────────────────────────────

  it('computes every time from the start plus durations, and numbers only the teaching rows', async () => {
    const id = await mkSchedule({ campusId, name: 'Regular', isDefault: true });
    const res = await put(`/api/v1/bell-schedules/${id}/days/1`, regularDay);
    expect(res.status).toBe(200);

    const monday = res.body.days.find((d: { dayOfWeek: number }) => d.dayOfWeek === 1);
    expect(monday.startsAt).toBe('08:00');
    // 08:00 +15 assembly → +40 +40 → +15 break → +40 +40. The value is asserted rather than derived
    // on purpose: a test that recomputes the sum the same way the code does checks nothing.
    expect(monday.endsAt).toBe('11:10');
    expect(monday.teachingPeriods).toBe(4);
    expect(monday.rows.map((r: { periodNo: number | null }) => r.periodNo)).toEqual([null, 1, 2, null, 3, 4]);
    // Contiguity is the property, not any single time: every row starts where the last one ended.
    for (let i = 1; i < monday.rows.length; i++) {
      expect(monday.rows[i].startTime).toBe(monday.rows[i - 1].endTime);
    }
  });

  it('gives each day its own shape — Friday is fewer rows, not a special case', async () => {
    const id = await mkSchedule({ campusId, name: 'Regular', isDefault: true });
    await put(`/api/v1/bell-schedules/${id}/days/1`, regularDay);
    const res = await put(`/api/v1/bell-schedules/${id}/days/5`, {
      startsAt: '08:00',
      rows: [{ isTeaching: true, minutes: 35 }, { isTeaching: true, minutes: 35 }],
    });

    const byDay = (d: number) => res.body.days.find((x: { dayOfWeek: number }) => x.dayOfWeek === d);
    expect(byDay(1).teachingPeriods).toBe(4);
    expect(byDay(5).teachingPeriods).toBe(2);
    // A day nobody composed is empty rather than defaulted — "not set" is a different answer from
    // "no periods", and only the grid should decide how to say so.
    expect(byDay(7).rows).toEqual([]);
  });

  it('will not accept a time from the client at all — the server owns the clock', async () => {
    const id = await mkSchedule({ campusId, name: 'Regular', isDefault: true });
    const res = await put(`/api/v1/bell-schedules/${id}/days/1`, {
      startsAt: '08:00',
      rows: [{ isTeaching: true, minutes: 40, startTime: '09:00', endTime: '10:30' }],
    });
    // 400 from forbidNonWhitelisted. This is what makes a gap inexpressible rather than merely
    // invalid: there is no field in which to send one.
    expect(res.status).toBe(400);
  });

  it('refuses a day that runs past midnight, and a day number that is not a day', async () => {
    const id = await mkSchedule({ campusId, name: 'Regular', isDefault: true });
    const late = await put(`/api/v1/bell-schedules/${id}/days/1`, {
      startsAt: '23:00', rows: [{ isTeaching: true, minutes: 120 }],
    });
    expect(late.status).toBe(422);
    expect(late.body.error.message).toMatch(/past midnight/i);

    const badDay = await put(`/api/v1/bell-schedules/${id}/days/9`, regularDay);
    expect(badDay.status).toBe(422);
  });

  it('answers a malformed id with 400, not the 500 an unvalidated uuid produces', async () => {
    const res = await get('/api/v1/bell-schedules/not-a-uuid');
    expect(res.status).toBe(400);
  });

  // ── one schedule per class ────────────────────────────────────────────────

  it('allows one default per campus and year', async () => {
    await mkSchedule({ campusId, name: 'Regular', isDefault: true });
    const second = await post('/api/v1/bell-schedules', { campusId, name: 'Another', isDefault: true });
    expect(second.status).toBe(409);
    expect(second.body.error.message).toMatch(/already has a default/i);
  });

  it('refuses a class that already follows another schedule, and names the one it follows', async () => {
    await mkSchedule({ campusId, name: 'Regular', isDefault: true });
    await mkSchedule({ campusId, name: 'Primary Wing', classIds: [classId] });

    const clash = await post('/api/v1/bell-schedules', { campusId, name: 'Evening Wing', classIds: [classId] });
    expect(clash.status).toBe(409);
    // ⚠️ This is THE invariant: two schedules claiming one class is exactly what would make
    // `periodNo` mean two different things for that class's sections.
    expect(clash.body.error.message).toMatch(/Grade 9 already follows "Primary Wing"/);
  });

  it('refuses a schedule nobody would follow, and a default that tries to name classes', async () => {
    const orphan = await post('/api/v1/bell-schedules', { campusId, name: 'Nobody', classIds: [] });
    expect(orphan.status).toBe(422);

    const bossy = await post('/api/v1/bell-schedules', { campusId, name: 'Default', isDefault: true, classIds: [classId] });
    expect(bossy.status).toBe(422);
  });

  it('refuses a class from another campus — the pair is wrong, not the caller', async () => {
    const res = await post('/api/v1/bell-schedules', { campusId, name: 'Wing', classIds: [farClassId] });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/another campus/i);
  });

  it('treats schedule names as case-insensitively unique per campus and year', async () => {
    await mkSchedule({ campusId, name: 'Regular', isDefault: true });
    const dup = await post('/api/v1/bell-schedules', { campusId, name: 'regular', classIds: [classId] });
    expect(dup.status).toBe(409);
  });

  // ── shrinking a day keeps the lessons ─────────────────────────────────────

  it('keeps lessons that fall off a shortened day, and says how many', async () => {
    const id = await mkSchedule({ campusId, name: 'Regular', isDefault: true });
    await put(`/api/v1/bell-schedules/${id}/days/1`, regularDay); // 4 teaching periods

    for (const periodNo of [3, 4]) {
      const slot = await post('/api/v1/timetable/slots', {
        sectionId: sectionA, dayOfWeek: 1, periodNo, subjectId, staffId,
      });
      expect(slot.status).toBe(201);
    }

    // Ramadan, in effect: the same day composed shorter. There is deliberately no dated variant, so
    // this IS the mechanism, which is precisely why it must not destroy anything.
    const shrunk = await put(`/api/v1/bell-schedules/${id}/days/1`, {
      startsAt: '08:00', rows: [{ isTeaching: true, minutes: 30 }, { isTeaching: true, minutes: 30 }],
    });
    expect(shrunk.status).toBe(200);
    expect(shrunk.body.retainedLessons).toBe(2);

    // The point of the rule: they are still there. A month of reduced timings must not cost a
    // school the grid it spent a week building.
    const stillThere = await platform.timetableSlot.count({ where: { schoolId, dayOfWeek: 1, periodNo: { gt: 2 } } });
    expect(stillThere).toBe(2);
  });

  it('counts only the lessons that actually ring to this bell', async () => {
    const wing = await mkSchedule({ campusId, name: 'Primary Wing', classIds: [classId] });
    const other = (await post('/api/v1/classes', { campusId, name: 'Grade 10', order: 10 })).body.id;
    const otherSection = (await post('/api/v1/sections', { classId: other, name: 'A' })).body.id;
    const otherSubject = (await post('/api/v1/subjects', { classId: other, name: 'Physics' })).body.id;
    const staff = await post('/api/v1/staff', {
      email: 'bellteach2@bell.pk', campusId, staffType: 'TEACHER', employeeCode: 'BT2',
      designation: 'Teacher', joinedAt: '2026-04-01', fullName: 'Other Teacher',
    });
    await put(`/api/v1/bell-schedules/${wing}/days/1`, regularDay);
    // A lesson in period 4 for a class that does NOT follow this wing schedule. Grade 10 has no
    // schedule of its own and no campus default here, so the period check lets it through — which
    // is the point of the check being conditional.
    await post('/api/v1/timetable/slots', {
      sectionId: otherSection, dayOfWeek: 1, periodNo: 4, subjectId: otherSubject, staffId: staff.body.staffId,
    });

    const shrunk = await put(`/api/v1/bell-schedules/${wing}/days/1`, {
      startsAt: '08:00', rows: [{ isTeaching: true, minutes: 30 }],
    });
    // Zero, not one: Grade 10 rings to the campus default, so shortening the Primary wing's day
    // says nothing about it. Counting every slot on the campus would have reported 1 here.
    expect(shrunk.body.retainedLessons).toBe(0);
  });

  // ── the grid reads the declared day (P1) ──────────────────────────────────

  it('refuses a lesson in a period the day does not have, and says how many it has', async () => {
    const id = await mkSchedule({ campusId, name: 'Regular', isDefault: true });
    await put(`/api/v1/bell-schedules/${id}/days/5`, {
      startsAt: '08:00', rows: [{ isTeaching: true, minutes: 35 }, { isTeaching: true, minutes: 35 }],
    });

    const ok = await post('/api/v1/timetable/slots', { sectionId: sectionA, dayOfWeek: 5, periodNo: 2, subjectId, staffId });
    expect(ok.status).toBe(201);

    const tooLate = await post('/api/v1/timetable/slots', { sectionId: sectionA, dayOfWeek: 5, periodNo: 3, subjectId, staffId });
    expect(tooLate.status).toBe(422);
    // Naming the count is what makes it actionable: a short Friday is deliberate, so the answer is
    // usually "put it on another day", not "make Friday longer".
    expect(tooLate.body.error.message).toMatch(/Friday has 2 periods in "Regular"/);
  });

  it('leaves a school with no timings exactly as it was — additive, not breaking', async () => {
    // No schedule exists in this test (afterEach clears them), which is the state EVERY existing
    // school is in on the day this ships. An unconditional period check would have taken the grid
    // away from all of them at once.
    const res = await post('/api/v1/timetable/slots', { sectionId: sectionA, dayOfWeek: 1, periodNo: 9, subjectId, staffId });
    expect(res.status).toBe(201);
  });

  it('carries the clock time on every lesson it returns', async () => {
    const id = await mkSchedule({ campusId, name: 'Regular', isDefault: true });
    await put(`/api/v1/bell-schedules/${id}/days/1`, regularDay);
    await post('/api/v1/timetable/slots', { sectionId: sectionA, dayOfWeek: 1, periodNo: 2, subjectId, staffId });

    const grid = await get(`/api/v1/timetable/section/${sectionA}`);
    expect(grid.status).toBe(200);
    // The grid's shape is the declared day, not `max(periodNo)` over what has been typed.
    expect(grid.body.bell.name).toBe('Regular');
    expect(grid.body.bell.days.find((d: { dayOfWeek: number }) => d.dayOfWeek === 1).teachingPeriods).toBe(4);
    // Period 2 is 08:55–09:35 once the assembly and period 1 are accounted for — a time the grid
    // could not have shown at all before, and the reason `withTimes` lives in the service rather
    // than on three separate screens.
    expect(grid.body.slots[0].startTime).toBe('08:55');
    expect(grid.body.slots[0].endTime).toBe('09:35');
  });

  it('gives a school with no timings null times rather than an invented zero', async () => {
    await post('/api/v1/timetable/slots', { sectionId: sectionA, dayOfWeek: 1, periodNo: 1, subjectId, staffId });
    const grid = await get(`/api/v1/timetable/section/${sectionA}`);
    expect(grid.body.bell).toBeNull();
    expect(grid.body.slots[0].startTime).toBeNull();
  });

  // ── advisory subject load (P2) ────────────────────────────────────────────

  it('reports the weekly load as placed-of-target, and never refuses an overshoot', async () => {
    await patch(`/api/v1/subjects/${subjectId}`, { periodsPerWeek: 2 });
    for (const periodNo of [1, 2, 3]) {
      const r = await post('/api/v1/timetable/slots', { sectionId: sectionA, dayOfWeek: 1, periodNo, subjectId, staffId });
      // Three placed against a target of two. Advisory means advisory — the third is accepted,
      // because a coordinator mid-build overshoots and rebalances, and a rule that blocks that
      // makes the tool worse than paper.
      expect(r.status).toBe(201);
    }
    const grid = await get(`/api/v1/timetable/section/${sectionA}`);
    const maths = grid.body.load.find((l: { name: string }) => l.name === 'Mathematics');
    expect(maths).toMatchObject({ target: 2, placed: 3 });
  });

  it('distinguishes an unallocated load from a load of zero', async () => {
    const grid = await get(`/api/v1/timetable/section/${sectionA}`);
    const maths = grid.body.load.find((l: { name: string }) => l.name === 'Mathematics');
    // Null, not 0. "We have not decided how many periods Maths gets" and "Maths gets none" are
    // different statements, and only one of them should light up a shortfall chip.
    expect(maths.target).toBeNull();
    expect(maths.placed).toBe(0);
  });

  it('counts only the subjects this section actually takes', async () => {
    const elective = (await post('/api/v1/subjects', { classId, name: 'Computer', periodsPerWeek: 2 })).body.id;
    // The section takes Maths and not Computer — which is exactly what `section_subjects` is for.
    await put(`/api/v1/sections/${sectionA}/subjects`, { subjectIds: [subjectId] });

    const grid = await get(`/api/v1/timetable/section/${sectionA}`);
    const names = grid.body.load.map((l: { name: string }) => l.name);
    expect(names).toEqual(['Mathematics']);
    // Iterating the CLASS's subjects would report a Computer shortfall against a section that does
    // not study it — the A12 finding, and the reason this reads SectionSubject.
    expect(names).not.toContain('Computer');
    expect(elective).toBeTruthy();
  });

  // ── campus scope ──────────────────────────────────────────────────────────

  it('keeps a campus admin inside their own campus, in both directions', async () => {
    const far = await mkSchedule({ campusId: farCampusId, name: 'Far Regular', isDefault: true });
    const own = await mkSchedule({ campusId, name: 'Own Regular', isDefault: true });

    const blocked = await asCampusAdmin.put(`/api/v1/bell-schedules/${far}/days/1`, regularDay);
    expect(blocked.status).toBe(403);

    const allowed = await asCampusAdmin.put(`/api/v1/bell-schedules/${own}/days/1`, regularDay);
    expect(allowed.status).toBe(200);

    // And the list is scoped, not merely the writes — a guarded write does not imply a guarded read
    // is a lesson this repo has already paid for twice.
    const listed = await asCampusAdmin.get('/api/v1/bell-schedules');
    expect(listed.body.schedules).toHaveLength(1);
    expect(listed.body.schedules[0].id).toBe(own);

    // The owner sees both — a filter that dropped the far campus for everybody would pass a
    // one-sided assertion while being just as wrong.
    const asOwner = await get('/api/v1/bell-schedules');
    expect(asOwner.body.schedules).toHaveLength(2);
  });

  // ── lifecycle ─────────────────────────────────────────────────────────────

  it('frees the default slot and the name when a schedule is retired', async () => {
    const id = await mkSchedule({ campusId, name: 'Regular', isDefault: true });
    expect((await del(`/api/v1/bell-schedules/${id}`)).status).toBe(200);

    // Both partial indexes are predicated on `deleted_at IS NULL`, so retiring one releases the
    // seat immediately — same rule as the campus seats.
    const replacement = await post('/api/v1/bell-schedules', { campusId, name: 'Regular', isDefault: true });
    expect(replacement.status).toBe(201);
    expect((await get('/api/v1/bell-schedules')).body.schedules).toHaveLength(1);
  });

  it('moves a class between schedules through an edit, but never into two at once', async () => {
    await mkSchedule({ campusId, name: 'Regular', isDefault: true });
    const wing = await mkSchedule({ campusId, name: 'Primary Wing', classIds: [classId] });
    // A second class on THIS campus. The first draft used `farClassId` and got a correct 422 —
    // the cross-campus rule firing on a fixture that had no business crossing a campus.
    const sibling = (await post('/api/v1/classes', { campusId, name: 'Grade 8', order: 8 })).body.id;
    const evening = await mkSchedule({ campusId, name: 'Evening Wing', classIds: [sibling] });

    const steal = await patch(`/api/v1/bell-schedules/${evening}`, { classIds: [classId] });
    expect(steal.status).toBe(409);

    expect((await patch(`/api/v1/bell-schedules/${wing}`, { classIds: [] })).status).toBe(422);
    expect((await patch(`/api/v1/bell-schedules/${wing}`, { name: 'Junior Wing' })).status).toBe(200);
  });
});
