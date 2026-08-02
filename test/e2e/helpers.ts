import { expect, request, type Locator, type Page } from '@playwright/test';

/** Where the setup projects save the shared authenticated sessions (gitignored). */
export const STORAGE_STATE = 'test/e2e/.auth/owner.json';
export const PLATFORM_STORAGE_STATE = 'test/e2e/.auth/platform.json';

/** Logs in via the /login form and waits for the app shell to land on /dashboard. */
export async function login(page: Page, email = 'owner@demo.pk', password = 'Owner!Secret12'): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/dashboard');
  await expect(page.locator('.sidebar')).toBeVisible();
}

/** Logs in to the vendor console via the /admin/login form and lands on /admin. */
export async function platformLogin(page: Page, email = 'admin@platform.pk', password = 'Admin!Secret12'): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/admin');
  await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible();
}

/** Enter the vendor console already authenticated (via the platform storageState). */
export async function gotoAdmin(page: Page): Promise<void> {
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible();
}

/**
 * Enter the app already authenticated (via the shared storageState) and wait for the
 * shell to render. Use this instead of `login()` in specs — only the setup project and
 * the smoke login-flow test do a real form login, to stay under the login rate limiter.
 */
export async function gotoApp(page: Page, path = '/dashboard'): Promise<void> {
  await page.goto(path);
  await expect(page.locator('.sidebar')).toBeVisible();
}

/**
 * Most app forms (students/admissions/attendance/exams…) render `<label>Text</label>`
 * immediately followed by the control, with no `htmlFor`/`id` association — so
 * `getByLabel` can't find them. These helpers locate by the CSS adjacent-sibling
 * relationship instead. Scope `within` to a card/row when the label text repeats
 * elsewhere on the page (e.g. "Guardian name" in both the inquiry and admit forms).
 */
export function fieldInput(within: Locator, label: string): Locator {
  return within.locator(`label:text-is("${label}") + input`);
}
export function fieldSelect(within: Locator, label: string): Locator {
  return within.locator(`label:text-is("${label}") + select`);
}

/**
 * Locates a `.card` section by its exact <h2> heading text. Safer than
 * `.locator('.card', { hasText })`, which does a substring match against the whole
 * card's text — e.g. `hasText: 'Terms'` also matches the Exams card because its
 * "Term" filter/select labels concatenate with other text into a false substring hit.
 */
export function cardByHeading(page: Page, heading: string): Locator {
  return page.locator('.card').filter({ has: page.getByRole('heading', { name: heading, level: 2, exact: true }) });
}

/**
 * Authenticated same-origin POST for test *setup* that the UI doesn't expose (e.g.
 * creating a fee head / fee structure before the Fees screen can generate invoices).
 * Reuses the logged-in browser context's session cookies and attaches the CSRF
 * double-submit header the same way `lib/api.ts` does. Must be called after `login()`.
 */
export async function apiSetupPost<T = unknown>(page: Page, path: string, body: unknown): Promise<T> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'csrf')?.value ?? '';
  const res = await page.request.post(`http://localhost:3001/api/v1${path}`, {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    data: body,
  });
  if (!res.ok()) throw new Error(`Setup POST ${path} failed: ${res.status()} ${await res.text()}`);
  return res.json() as Promise<T>;
}

/** Authenticated same-origin GET for test setup (reads seed ids like the current year). */
export async function apiSetupGet<T = unknown>(page: Page, path: string): Promise<T> {
  const res = await page.request.get(`http://localhost:3001/api/v1${path}`);
  if (!res.ok()) throw new Error(`Setup GET ${path} failed: ${res.status()} ${await res.text()}`);
  return res.json() as Promise<T>;
}

/**
 * A recent date safe for attendance marking: not in the future and not the school's
 * default weekly-off (SUNDAY). Walks back from today until it lands on a non-Sunday.
 * Returned as YYYY-MM-DD (UTC), matching the screen's `<input type="date">` value.
 */
export function safeAttendanceDate(): string {
  const d = new Date();
  while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface SeededClass {
  className: string;
  sectionName: string;
  classId: string;
  sectionId: string;
  subjectId: string;
  subjectName: string;
  campusId: string;
}

export interface SeededClassWithStudent extends SeededClass {
  studentName: string;
}

/**
 * A fresh, timestamp-unique class → section → subject, seeded through the **API**.
 *
 * It used to drive the Setup screen, filling a "Classes" card and a separate "Sections" card
 * and asserting a "Class created" toast — none of which exist any more, which is why
 * `pnpm test:e2e` could not pass. Seeding fixtures through the UI makes every spec in the
 * suite a hostage of whichever screen happens to own that data this month; it is also slow.
 * The UI is what the specs are here to TEST, not what they should be built out of.
 *
 * Assumes an owner session (storageState or `login()`), and leaves the page where it was.
 */
export async function seedClassSection(page: Page): Promise<SeededClass> {
  const ts = Date.now();
  const className = `Cls${ts}`;
  const sectionName = 'A';
  const subjectName = `Subj${ts}`;

  const campuses = await apiSetupGet<{ id: string }[]>(page, '/campuses');
  if (!campuses.length) throw new Error('Seed failed: the tenant has no campus — a class must belong to one.');
  const campusId = campuses[0].id;

  const existing = await apiSetupGet<{ order: number; campusId: string }[]>(page, '/classes');
  const order = Math.max(0, ...existing.filter((k) => k.campusId === campusId).map((k) => k.order)) + 1;

  const klass = await apiSetupPost<{ id: string }>(page, '/classes', { campusId, name: className, order });
  const subject = await apiSetupPost<{ id: string }>(page, '/subjects', { classId: klass.id, name: subjectName });
  const section = await apiSetupPost<{ id: string }>(page, '/sections', { classId: klass.id, name: sectionName, capacity: 40 });

  return {
    className, sectionName, subjectName, campusId,
    classId: klass.id, sectionId: section.id, subjectId: subject.id,
  };
}

/**
 * As above, plus an admitted student — for specs that need an enrolled child (attendance,
 * fees, reports, CSV import).
 *
 * ⚠️ Admitting is **`ADMISSION_CONTROLLER`-only** by an explicit product decision (segregation
 * of duties): the owner session every other spec uses is 403 on `POST /students`. There is
 * also at most ONE officer per campus, so this helper must NOT mint or reassign the seat —
 * on a real tenant that would take the seat away from the person holding it, on every run.
 *
 * So it signs in as an officer you nominate. Set both variables to a campus officer whose
 * campus the seeded class lands in:
 *
 *     E2E_ADMISSION_OFFICER_EMAIL=... E2E_ADMISSION_OFFICER_PASSWORD=... pnpm test:e2e
 *
 * Without them the specs that need a student fail with this explanation rather than with a
 * timeout against a form that no longer exists.
 */
export async function seedClassSectionStudent(page: Page): Promise<SeededClassWithStudent> {
  const seeded = await seedClassSection(page);
  const email = process.env.E2E_ADMISSION_OFFICER_EMAIL;
  const password = process.env.E2E_ADMISSION_OFFICER_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'Cannot seed a student: admitting is ADMISSION_CONTROLLER-only and the shared session is the owner. '
      + 'Set E2E_ADMISSION_OFFICER_EMAIL and E2E_ADMISSION_OFFICER_PASSWORD to an officer holding the seat '
      + 'for the campus under test. The helper deliberately does not assign the seat itself — there is one '
      + 'officer per campus, and taking it would displace the real holder on every run.',
    );
  }

  const ts = Date.now();
  const studentName = `Student ${ts}`;
  // A separate request context so the owner's storageState session is left untouched.
  const officer = await request.newContext({ baseURL: 'http://localhost:3001' });
  try {
    const auth = await officer.post('/api/v1/auth/login', { data: { email, password } });
    if (!auth.ok()) throw new Error(`Admission officer login failed: ${auth.status()} ${await auth.text()}`);
    const csrf = (await officer.storageState()).cookies.find((c: { name: string; value: string }) => c.name === 'csrf')?.value ?? '';
    const res = await officer.post('/api/v1/students', {
      headers: { 'X-CSRF-Token': csrf },
      data: {
        fullName: studentName, gender: 'MALE', dateOfBirth: '2015-01-15',
        campusId: seeded.campusId, classId: seeded.classId, sectionId: seeded.sectionId,
        guardian: { mode: 'CREATE', fullName: 'Guardian', phone: `03${String(ts).slice(-9)}`, relation: 'FATHER' },
      },
    });
    if (!res.ok()) throw new Error(`Admit failed: ${res.status()} ${await res.text()}`);
  } finally {
    await officer.dispose();
  }

  return { ...seeded, studentName };
}
