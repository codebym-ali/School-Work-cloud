import { test as setup, expect, request, type APIRequestContext } from '@playwright/test';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { authenticator } from 'otplib';
import { PLATFORM_STORAGE_STATE } from '../helpers';
import { WORLD_FILE, type QaWorld } from './qa-world';

/**
 * Builds the QA world for the Owner Gaps QA Test Plan (see `school-works-brain/08-Delivery/Owner Gaps QA Test Plan.md`).
 *
 * Provisioned through the vendor console API, then populated through the tenant API as the people who would really do
 * each thing: the owner configures, the admission officer admits, the owner bills and collects. Only two facts are
 * written to the database directly, because no screen can produce them in a test: a guardian's phone being verified
 * (that needs a real SMS OTP) and an enrolment start date in the past (so July is a month the student was billed for).
 */
const API = 'http://localhost:4000';
const PASSWORD = 'QaWorld!Secret1234';

function loadEnv() {
  const envPath = join(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    if (!(k in process.env)) process.env[k] = t.slice(i + 1).trim();
  }
}

/** A tenant API client with its own cookie jar, speaking to the API directly with the tenant's Host header. */
async function tenantClient(host: string): Promise<APIRequestContext & { csrf: () => Promise<string> }> {
  const ctx = await request.newContext({ baseURL: API, extraHTTPHeaders: { Host: host } });
  return Object.assign(ctx, {
    csrf: async () => (await ctx.storageState()).cookies.find((c) => c.name === 'csrf')?.value ?? '',
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic test helper default
async function call<T = any>(c: Awaited<ReturnType<typeof tenantClient>>, method: 'get' | 'post' | 'put' | 'patch', path: string, data?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await c[method](`/api/v1${path}`, { data, headers: { 'X-CSRF-Token': await c.csrf(), ...headers } });
  if (res.status() >= 300) throw new Error(`${method.toUpperCase()} ${path} → ${res.status()} ${await res.text()}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

async function login(host: string, email: string, door: 'owner' | 'staff', secret?: string) {
  const c = await tenantClient(host);
  const res = await c.post(`/api/v1/auth/${door === 'owner' ? 'owner-login' : 'login'}`, { data: { email, password: PASSWORD } });
  expect(res.status(), `login ${email}`).toBe(200);
  const body = await res.json();
  if (body.mfaRequired) {
    if (authenticator.timeRemaining() < 5) await new Promise((r) => setTimeout(r, (authenticator.timeRemaining() + 1) * 1000));
    const ch = await c.post('/api/v1/auth/mfa/challenge', { data: { mfaToken: body.mfaToken, code: authenticator.generate(secret!) } });
    expect(ch.status(), `mfa ${email}`).toBe(200);
  }
  return c;
}

async function enrol(c: Awaited<ReturnType<typeof tenantClient>>): Promise<string> {
  const setupRes = await call<{ otpauthUrl: string }>(c, 'post', '/auth/mfa/setup', {});
  const secret = new URL(setupRes.otpauthUrl).searchParams.get('secret')!;
  if (authenticator.timeRemaining() < 5) await new Promise((r) => setTimeout(r, (authenticator.timeRemaining() + 1) * 1000));
  await call(c, 'post', '/auth/mfa/verify', { code: authenticator.generate(secret) });
  return secret;
}

setup('provision the QA world', async () => {
  setup.setTimeout(180_000);
  loadEnv();
  const stamp = Date.now();
  // No hyphen: the dev proxy's tenant match in next.config falls back to the demo school for a hyphenated subdomain.
  const subdomain = `qa${stamp}`;
  const host = `${subdomain}.localhost`;

  // ── Provision through the vendor console API ────────────────────────────────
  const platform = await request.newContext({ baseURL: API, storageState: PLATFORM_STORAGE_STATE });
  const pcsrf = (await platform.storageState()).cookies.find((c) => c.name === 'platform_csrf')?.value ?? '';
  const prov = await platform.post('/api/v1/platform/tenants', {
    data: { name: 'QA School', subdomain, ownerEmail: 'owner@qa.pk' }, headers: { 'X-CSRF-Token': pcsrf },
  });
  expect(prov.status(), await prov.text()).toBe(201);
  const provBody = await prov.json();
  const schoolId: string = provBody.schoolId ?? provBody.id;
  const token: string = provBody.onboardingToken;
  expect(token, 'provisioning returns an onboarding token').toBeTruthy();

  const anon = await tenantClient(host);
  const reset = await anon.post('/api/v1/auth/reset-password', { data: { token, newPassword: PASSWORD } });
  expect(reset.status(), await reset.text()).toBeLessThan(300);

  let owner = await login(host, 'owner@qa.pk', 'owner');
  const ownerSecret = await enrol(owner);
  owner = await login(host, 'owner@qa.pk', 'owner', ownerSecret);

  // ── Structure ───────────────────────────────────────────────────────────────
  const campuses = await call<Array<{ id: string; name: string }>>(owner, 'get', '/campuses');
  const campusA = campuses[0];
  const campusB = await call<{ id: string; name: string }>(owner, 'post', '/campuses', { name: 'QA Campus B' });
  await call(owner, 'post', '/academic-years', { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  const nextYear = await call<{ id: string }>(owner, 'post', '/academic-years', { name: '2027-28', startDate: '2027-04-01', endDate: '2028-03-31' });

  const klass = async (campusId: string, name: string, order: number) => {
    const c = await call<{ id: string }>(owner, 'post', '/classes', { campusId, name, order });
    const s = await call<{ id: string }>(owner, 'post', '/sections', { classId: c.id, name: 'A' });
    return { classId: c.id, sectionId: s.id };
  };
  const oneA = await klass(campusA.id, 'QA One', 1);
  const twoA = await klass(campusA.id, 'QA Two', 2);
  const oneB = await klass(campusB.id, 'QA One B', 1);

  const year = (await call<Array<{ id: string; isCurrent: boolean }>>(owner, 'get', '/academic-years')).find((y) => y.isCurrent)!;
  const head = await call<{ id: string }>(owner, 'post', '/fee-heads', { name: 'QA Tuition' });
  for (const [campusId, classId] of [[campusA.id, oneA.classId], [campusB.id, oneB.classId]]) {
    await call(owner, 'post', '/fee-structures', { campusId, classId, feeHeadId: head.id, academicYearId: year.id, amount: 3000, frequency: 'MONTHLY' });
  }

  // ── People ──────────────────────────────────────────────────────────────────
  const staffIds: Record<string, string> = {};
  const hire = async (key: string, email: string, campusId: string, staffType: string, roles: string[], fullName: string, salary?: number) => {
    const s = await call<{ staffId: string }>(owner, 'post', '/staff', {
      email, staffType, employeeCode: `QA-${key}`, fullName, designation: staffType, joinedAt: '2026-01-01', campusId, password: PASSWORD, roles,
    });
    staffIds[key] = s.staffId;
    if (salary) await call(owner, 'post', `/staff/${s.staffId}/salary-structures`, { basic: salary, effectiveFrom: '2026-01-01' });
  };
  await hire('acctA', 'accountant.a@qa.pk', campusA.id, 'ACCOUNTANT', ['ACCOUNTANT'], 'Asma Accountant', 30000);
  await hire('acctB', 'accountant.b@qa.pk', campusB.id, 'ACCOUNTANT', ['ACCOUNTANT'], 'Babar Accountant', 30000);
  await hire('adminA', 'campus.admin@qa.pk', campusA.id, 'ADMIN', ['CAMPUS_ADMIN'], 'Camila Admin'); // no salary: PAY-03
  await hire('teacherA', 'teacher@qa.pk', campusA.id, 'TEACHER', ['TEACHER'], 'Tariq Teacher', 40000);
  await hire('admA', 'admissions.a@qa.pk', campusA.id, 'CLERK', ['ADMISSION_CONTROLLER'], 'Adeel Admissions');
  await hire('admB', 'admissions.b@qa.pk', campusB.id, 'CLERK', ['ADMISSION_CONTROLLER'], 'Bushra Admissions');
  // AssignCampus fixture (C-AssignCampus): a mis-configured login — a campus-scoped role with no
  // campus. No screen produces this state; its campus is nulled below with the other DB-only facts.
  await hire('orphan', 'orphan.teacher@qa.pk', campusA.id, 'TEACHER', ['TEACHER'], 'Orphan Teacher');
  // C9 fixture: the teacher marks attendance, and the picker is fed by their TeacherAssignments — so
  // give Tariq the QA One A register to mark. oneA already holds admitted students.
  await call(owner, 'post', '/teacher-assignments', { staffId: staffIds.teacherA, academicYearId: year.id, sectionId: oneA.sectionId });

  const acctASecret = await enrol(await login(host, 'accountant.a@qa.pk', 'staff'));
  const acctBSecret = await enrol(await login(host, 'accountant.b@qa.pk', 'staff'));

  // ── Students, admitted by each campus's admission officer ───────────────────
  const officerA = await login(host, 'admissions.a@qa.pk', 'staff');
  const officerB = await login(host, 'admissions.b@qa.pk', 'staff');
  let phoneSeq = 0;
  const admit = async (officer: typeof officerA, campusId: string, place: { classId: string; sectionId: string }, fullName: string) => {
    phoneSeq += 1;
    const phone = `0300${String(stamp).slice(-5)}${String(phoneSeq).padStart(2, '0')}`;
    const s = await call<{ studentId: string; enrollmentId: string; parentId: string }>(officer, 'post', '/students', {
      fullName, gender: 'MALE', dateOfBirth: '2014-02-02', campusId, ...place,
      guardian: { mode: 'CREATE', fullName: `${fullName.split(' ')[0]}'s Mother`, phone, relation: 'MOTHER' },
    });
    return { ...s, phone, name: fullName };
  };
  const paid = await admit(officerA, campusA.id, oneA, 'Ali Raza');
  const owingWaive = await admit(officerA, campusA.id, oneA, 'Sara Khan');
  const owingWithdraw = await admit(officerA, campusA.id, oneA, 'Omar Farooq');
  const noDues = await admit(officerA, campusA.id, twoA, 'Hamza Tariq');
  const optedOut = await admit(officerA, campusA.id, twoA, 'Zoya Ahmed');
  const campusBStudent = await admit(officerB, campusB.id, oneB, 'Bilal Bashir');

  // ── The two facts no screen can produce in a test ───────────────────────────
  const prisma = new PrismaClient({ datasourceUrl: process.env.PLATFORM_DATABASE_URL ?? process.env.DATABASE_URL });
  try {
    for (const s of [paid, owingWithdraw, noDues, campusBStudent]) {
      await prisma.parentProfile.update({ where: { id: s.parentId }, data: { phoneVerifiedAt: new Date() } });
    }
    await prisma.parentProfile.update({ where: { id: optedOut.parentId }, data: { phoneVerifiedAt: new Date(), smsOptOut: true } });
    await prisma.studentEnrollment.updateMany({ where: { schoolId }, data: { startedAt: new Date('2026-04-01') } });
    // Strand the orphan teacher: a TEACHER with no campus is the exact state the "Needs a campus"
    // control repairs. Only a DB write (a deleted campus, a bad import) reaches it — a screen cannot.
    await prisma.user.updateMany({ where: { schoolId, email: 'orphan.teacher@qa.pk' }, data: { campusId: null } });
  } finally {
    await prisma.$disconnect();
  }

  // ── Money: July billed for QA One (both campuses), Ali pays in cash ────────
  await call(owner, 'post', '/fees/invoice-batches', { classId: oneA.classId, month: 7, year: 2026 });
  await call(owner, 'post', '/fees/invoice-batches', { classId: oneB.classId, month: 7, year: 2026 });
  const inv = await call<{ data: Array<{ id: string; totalAmount: string }> }>(owner, 'get', `/fees/invoices?studentId=${paid.studentId}`);
  await call(owner, 'post', `/fees/invoices/${inv.data[0].id}/payments`, { amountPaid: Number(inv.data[0].totalAmount), method: 'CASH' }, { 'Idempotency-Key': `qa-${stamp}-pay` });

  const out: QaWorld = {
    subdomain, schoolId, password: PASSWORD,
    campusA: { id: campusA.id, name: campusA.name }, campusB: { id: campusB.id, name: campusB.name },
    nextYearId: nextYear.id,
    accounts: {
      owner: { email: 'owner@qa.pk', door: 'owner', mfaSecret: ownerSecret },
      campusAdmin: { email: 'campus.admin@qa.pk', door: 'staff' },
      accountantA: { email: 'accountant.a@qa.pk', door: 'staff', mfaSecret: acctASecret },
      accountantB: { email: 'accountant.b@qa.pk', door: 'staff', mfaSecret: acctBSecret },
      teacher: { email: 'teacher@qa.pk', door: 'staff' },
    },
    staffIds,
    students: {
      paid: { id: paid.studentId, name: paid.name },
      owingWaive: { id: owingWaive.studentId, name: owingWaive.name },
      owingWithdraw: { id: owingWithdraw.studentId, name: owingWithdraw.name },
      noDues: { id: noDues.studentId, name: noDues.name },
      optedOut: { id: optedOut.studentId, name: optedOut.name },
      campusB: { id: campusBStudent.studentId, name: campusBStudent.name },
    },
    phones: { optedOut: optedOut.phone },
    teacherSection: { sectionId: oneA.sectionId, label: 'QA One A' },
    campusLessUser: { email: 'orphan.teacher@qa.pk' },
  };
  mkdirSync('test/e2e/.auth', { recursive: true });
  writeFileSync(WORLD_FILE, JSON.stringify(out, null, 2));
});
