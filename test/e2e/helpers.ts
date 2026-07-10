import { expect, type Locator, type Page } from '@playwright/test';

/** Where the setup project saves the shared authenticated session (gitignored). */
export const STORAGE_STATE = 'test/e2e/.auth/owner.json';

/** Logs in via the /login form and waits for the app shell to land on /dashboard. */
export async function login(page: Page, email = 'owner@demo.pk', password = 'Owner!Secret12'): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/dashboard');
  await expect(page.locator('.sidebar')).toBeVisible();
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
  studentName: string;
}

/**
 * Drives Setup + Students through the UI to create a fresh, timestamp-unique
 * class → section → admitted student, so a spec that needs an enrolled student is
 * self-contained and independent of seed/prior-spec data. Returns the created names.
 * Assumes `login()` already ran; leaves the page on /students.
 */
export async function seedClassSectionStudent(page: Page): Promise<SeededClass> {
  const ts = Date.now();
  const className = `Cls${ts}`;
  const sectionName = 'A';
  const studentName = `Student ${ts}`;
  const guardianPhone = `03${String(ts).slice(-9)}`;

  await page.getByRole('link', { name: 'Setup', exact: true }).click();
  await page.waitForURL('**/setup');

  const classCard = cardByHeading(page, 'Classes');
  await fieldSelect(classCard, 'Campus').selectOption({ index: 1 });
  await fieldInput(classCard, 'Name').fill(className);
  await classCard.getByRole('button', { name: 'Add class' }).click();
  await expect(page.locator('.toast.ok')).toContainText('Class created');

  const sectionCard = cardByHeading(page, 'Sections');
  await fieldSelect(sectionCard, 'Class').selectOption({ label: className });
  await fieldInput(sectionCard, 'Name').fill(sectionName);
  await sectionCard.getByRole('button', { name: 'Add section' }).click();
  await expect(page.locator('.toast.ok')).toContainText('Section created');

  await page.getByRole('link', { name: 'Students', exact: true }).click();
  await page.waitForURL('**/students');
  await page.getByRole('button', { name: '+ Add student' }).click();
  const addStudentCard = cardByHeading(page, 'New student');
  await fieldInput(addStudentCard, 'Full name').fill(studentName);
  await fieldInput(addStudentCard, 'Date of birth').fill('2015-01-15');
  await fieldSelect(addStudentCard, 'Class').selectOption({ label: className });
  await fieldSelect(addStudentCard, 'Section').selectOption({ label: sectionName });
  await fieldInput(addStudentCard, 'Guardian name').fill('Guardian');
  await fieldInput(addStudentCard, 'Guardian phone').fill(guardianPhone);
  await addStudentCard.getByRole('button', { name: 'Admit student' }).click();
  await expect(page.locator('.toast.ok')).toContainText('Admitted');

  return { className, sectionName, studentName };
}
