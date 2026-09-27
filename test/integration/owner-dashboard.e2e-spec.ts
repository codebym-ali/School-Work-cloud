import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { SMS_QUEUE } from '../../apps/api/src/modules/comms/sms/sms.types';
import { admissionController } from './support/admission';
import { destroyTenant } from './support/tenant';
import { loginAs } from './support/login';

/**
 * Owner Dashboard Redesign — Phase 2 API fields (2026-09-27).
 *
 *  - `outstandingTotal` must describe the SAME students as `defaulterCount` (one predicate).
 *  - `monthBilled` / `monthBilledPaid` are this month's own invoices, waived ones excluded.
 *  - `schoolDay` + `todayAttendanceExpected`: nobody is expected on a closed day, and a closed
 *    campus's children drop out of the whole-school count.
 *  - an ACCOUNTANT gets the money context and none of the attendance figures.
 *
 * Every case pins `weeklyOffDays` itself, so the suite gives the same answer on any weekday.
 * Money is asserted as a DELTA from a baseline, so an invoice some other flow creates on admission
 * cannot make these numbers drift.
 */
describe('Owner dashboard — Phase 2 fields (e2e)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let campusId: string;
  let northId: string;
  let owner: string[];
  let csrf: string;
  const enrolments: Array<{ studentId: string; enrollmentId: string }> = [];

  const sub = `odb-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const email = 'owner@odb.pk';
  const password = 'Owner!Secret12';
  const WEEK = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const today = new Date(`${todayIso}T00:00:00Z`);
  const daysAgo = (n: number) => new Date(today.getTime() - n * 86_400_000);

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (p: string, b: object = {}) =>
    request(server()).post(p).set('Host', host).set('Cookie', owner).set('X-CSRF-Token', csrf).send(b);
  const dashboard = async (cookies = owner, q = '') => {
    const res = await request(server()).get(`/api/v1/dashboard${q}`).set('Host', host).set('Cookie', cookies);
    expect(res.status).toBe(200);
    return res.body;
  };
  const setWeeklyOff = async (days: string[]) => {
    const res = await request(server()).patch('/api/v1/school-settings').set('Host', host)
      .set('Cookie', owner).set('X-CSRF-Token', csrf).send({ weeklyOffDays: days });
    expect(res.status).toBe(200);
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
      .provisionSchool({ name: 'Dashboard School', subdomain: sub, ownerEmail: email, ownerPassword: password });
    schoolId = prov.schoolId;
    campusId = prov.campusId;
    owner = await loginAs(server(), host, email, password, 'owner');
    csrf = csrfOf(owner);

    await post('/api/v1/academic-years', {
      name: 'Current', startDate: `${now.getUTCFullYear() - 1}-01-01`, endDate: `${now.getUTCFullYear() + 1}-12-31`, isCurrent: true,
    });
    const classId = (await post('/api/v1/classes', { campusId, name: 'Grade 3', order: 3 })).body.id;
    const sectionId = (await post('/api/v1/sections', { classId, name: 'A' })).body.id;

    const { admit } = await admissionController(app, platform, schoolId, host, campusId);
    for (const [i, name] of ['Amna Tariq', 'Bilal Aslam'].entries()) {
      const res = await admit({
        fullName: name, gender: i ? 'MALE' : 'FEMALE', dateOfBirth: '2017-03-10', campusId, classId, sectionId,
        admissionDate: daysAgo(30).toISOString().slice(0, 10),
        guardian: { mode: 'CREATE', fullName: `Parent ${i}`, phone: `+92300123450${i}`, relation: 'FATHER' },
      });
      expect(res.status).toBe(201);
      const enrollment = await platform.studentEnrollment.findFirstOrThrow({ where: { studentId: res.body.studentId, status: 'ACTIVE' } });
      enrolments.push({ studentId: res.body.studentId, enrollmentId: enrollment.id });
    }

    // A second, empty campus — so one campus can close while the school stays open.
    northId = (await platform.campus.create({ data: { schoolId, name: 'North Campus' } })).id;
  });

  afterAll(async () => {
    const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  it('owed amount and defaulter count describe the same students; billed is this month, waived excluded', async () => {
    const before = await dashboard();
    const [a, b] = enrolments;
    const month = now.getUTCMonth() + 1;
    const year = now.getUTCFullYear();
    const lastMonth = new Date(Date.UTC(year, now.getUTCMonth() - 1, 1));
    const invoice = (e: typeof a, data: { total: number; paid: number; status: 'PAID' | 'PARTIAL' | 'OVERDUE' | 'WAIVED'; due: Date; month: number; year: number }) =>
      platform.feeInvoice.create({
        data: {
          schoolId, studentId: e.studentId, enrollmentId: e.enrollmentId,
          totalAmount: data.total, paidAmount: data.paid, status: data.status, dueDate: data.due, month: data.month, year: data.year,
        },
      });

    // One invoice per student per month (a partial unique in SQL), so each student carries one here.
    await invoice(a, { total: 7000, paid: 0, status: 'WAIVED', due: daysAgo(1), month, year }); // not asked of anyone
    await invoice(a, { total: 5000, paid: 5000, status: 'PAID', due: daysAgo(40), month: lastMonth.getUTCMonth() + 1, year: lastMonth.getUTCFullYear() });
    await invoice(b, { total: 5000, paid: 1000, status: 'PARTIAL', due: daysAgo(1), month, year }); // owes 4,000
    await invoice(b, { total: 5000, paid: 0, status: 'OVERDUE', due: daysAgo(40), month: lastMonth.getUTCMonth() + 1, year: lastMonth.getUTCFullYear() }); // owes 5,000

    const after = await dashboard();
    expect(after.monthBilled - before.monthBilled).toBe(5000); // the waived 7,000 is not billed; last month's are not this month's
    expect(after.monthBilledPaid - before.monthBilledPaid).toBe(1000);
    // One more student owes money, and the amount is exactly what THAT student owes across both invoices.
    expect(after.defaulterCount - before.defaulterCount).toBe(1);
    expect(after.outstandingTotal - before.outstandingTotal).toBe(9000);
    expect(typeof after.lastMonthToDate).toBe('number');
  });

  it('a working day is open and expects every enrolled child', async () => {
    await setWeeklyOff([]);
    const d = await dashboard();
    expect(d.schoolDay).toEqual({ open: true, reason: null });
    expect(d.todayAttendanceExpected).toBe(2);
  });

  it('a weekly-off day is closed and expects nobody — no "2 not yet" on a day with no register', async () => {
    await setWeeklyOff([WEEK[now.getUTCDay()]]);
    const d = await dashboard();
    expect(d.schoolDay).toEqual({ open: false, reason: 'Weekly off' });
    expect(d.todayAttendanceExpected).toBe(0);
    expect(d.attendanceBreakdown.unmarked).toBe(0);
    await setWeeklyOff([]);
  });

  it('a school-wide holiday closes the school and names itself', async () => {
    await setWeeklyOff([]);
    const h = await platform.holiday.create({ data: { schoolId, date: today, name: 'Founders Day' } });
    try {
      const d = await dashboard();
      expect(d.schoolDay).toEqual({ open: false, reason: 'Founders Day' });
      expect(d.todayAttendanceExpected).toBe(0);
    } finally {
      await platform.holiday.delete({ where: { id: h.id } });
    }
  });

  it('one campus shut: the school stays open, and that campus\'s children are no longer expected', async () => {
    await setWeeklyOff([]);
    const h = await platform.holiday.create({ data: { schoolId, date: today, name: 'Local closure', campusId } });
    try {
      const whole = await dashboard();
      expect(whole.schoolDay.open).toBe(true); // North Campus is working
      expect(whole.todayAttendanceExpected).toBe(0); // both children are on the shut campus

      // Through the lens of the shut campus itself, the day is closed.
      const lens = await dashboard(owner, `?campusId=${campusId}`);
      expect(lens.schoolDay).toEqual({ open: false, reason: 'Local closure' });

      // …and a holiday on the empty campus changes nothing for the children.
      await platform.holiday.delete({ where: { id: h.id } });
      const north = await platform.holiday.create({ data: { schoolId, date: today, name: 'North only', campusId: northId } });
      const d = await dashboard();
      expect(d.schoolDay.open).toBe(true);
      expect(d.todayAttendanceExpected).toBe(2);
      await platform.holiday.delete({ where: { id: north.id } });
    } finally {
      await platform.holiday.deleteMany({ where: { schoolId, date: today } });
    }
  });

  it('an ACCOUNTANT gets the money context but none of the attendance figures', async () => {
    const acct = { email: 'accounts@odb.pk', password: 'Accounts!Secret12' };
    await platform.user.create({
      data: {
        schoolId, email: acct.email, roles: ['ACCOUNTANT'] as never, status: 'ACTIVE',
        passwordHash: await argon2.hash(acct.password, { type: argon2.argon2id }),
      },
    });
    const cookies = await loginAs(server(), host, acct.email, acct.password, 'staff');
    const d = await dashboard(cookies);
    expect(typeof d.outstandingTotal).toBe('number');
    expect(typeof d.monthBilled).toBe('number');
    expect(d.todayAttendanceExpected).toBeNull();
    expect(d.attendanceBreakdown).toBeNull();
    expect(d.visible).not.toContain('todayAttendancePercent');
  });
});
