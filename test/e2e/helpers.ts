import { expect, request, type Locator, type Page } from '@playwright/test';

/** Where the setup projects save the shared authenticated sessions (gitignored). */
export const STORAGE_STATE = 'test/e2e/.auth/owner.json';
export const PLATFORM_STORAGE_STATE = 'test/e2e/.auth/platform.json';

/**
 * Logs in via the /login form and waits for the app shell.
 *
 * `landing` is a parameter because **the landing page is role-dependent** (`landingPath` in
 * `lib/roles.ts`): an owner gets /dashboard, an admission officer /admissions, a student /me.
 * Hardcoding /dashboard meant any non-owner login timed out on a navigation that was never
 * going to happen — which reads as "login is broken" rather than "wrong expectation".
 */
export async function login(
  page: Page,
  email = 'owner@demo.pk',
  password = 'Owner!Secret12',
  landing = '**/dashboard',
  door: 'staff' | 'owner' = 'owner',
): Promise<void> {
  // ⚠️ **Since the front-end split, the ORIGIN is the door, not the path.** Each app serves its own
  // door at `/login`: owner-web:3005/login is the owner form, staff-web:3006/login the staff form.
  // A spec picks its door by its `baseURL` — the default project is owner-web (owner credentials);
  // staff/officer specs `test.use({ baseURL: 'http://localhost:3006' })`. The `door` arg is kept for
  // call-site compatibility but no longer selects the path (there is no single-origin chooser here).
  void door;
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  // ⚠️ `exact: true`. getByLabel is a SUBSTRING match, and the password field now sits beside a
  // show/hide toggle whose accessible name is "Show password" — so a loose 'Password' resolves
  // BOTH and fails strict mode. Same trap as `getByLabel('Minutes, row 1')` matching row 10/11/12
  // (Key Decisions): the locator was always loose; a second control merely exposed it.
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(landing);
  await expect(page.locator('.sidebar')).toBeVisible();
}

/**
 * Logs in to the vendor console and lands on its home.
 *
 * ⚠️ Post-split the console is its **own app** (superadmin-web:3004), serving the login form at
 * `/login` and the tenants home at `/` — not `/admin/*` inside apps/web. Absolute URLs, because the
 * console origin differs from the default (owner-web) `baseURL`.
 */
export const CONSOLE_ORIGIN = 'http://localhost:3004';
export async function platformLogin(page: Page, email = 'admin@platform.pk', password = 'Admin!Secret12'): Promise<void> {
  await page.goto(`${CONSOLE_ORIGIN}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible();
}

/** Enter the vendor console already authenticated (via the platform storageState). */
export async function gotoAdmin(page: Page): Promise<void> {
  await page.goto(`${CONSOLE_ORIGIN}/`);
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
  const res = await page.request.post(`/api/v1${path}`, {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    data: body,
  });
  if (!res.ok()) throw new Error(`Setup POST ${path} failed: ${res.status()} ${await res.text()}`);
  return res.json() as Promise<T>;
}

/**
 * Authenticated same-origin PUT. Needed because a bell-schedule day is written as a whole — the
 * only granularity at which a day-level invariant can hold — so there is no POST to seed one with.
 */
export async function apiSetupPut<T = unknown>(page: Page, path: string, body: unknown): Promise<T> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'csrf')?.value ?? '';
  const res = await page.request.put(`/api/v1${path}`, {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    data: body,
  });
  if (!res.ok()) throw new Error(`Setup PUT ${path} failed: ${res.status()} ${await res.text()}`);
  return res.json() as Promise<T>;
}

/**
 * Authenticated same-origin PATCH.
 *
 * Needed because **some roles cannot be minted with an account — they are granted to an existing
 * employee.** `MANAGEABLE_ROLES` (what `POST /users` accepts) deliberately excludes `HR_MANAGER`;
 * it lives in `ACCESS_GRANTABLE_ROLES` and is conferred by `PATCH /users/:id/access`, because HR
 * access is a hat you give someone who already works here, not a new set of credentials. A spec
 * needing such a person has to create-then-grant, exactly as the Staff screen does.
 */
export async function apiSetupPatch<T = unknown>(page: Page, path: string, body: unknown): Promise<T> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'csrf')?.value ?? '';
  const res = await page.request.patch(`/api/v1${path}`, {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    data: body,
  });
  if (!res.ok()) throw new Error(`Setup PATCH ${path} failed: ${res.status()} ${await res.text()}`);
  return res.json() as Promise<T>;
}

/**
 * Authenticated same-origin DELETE, for a spec tidying up what it created.
 *
 * These specs run against the operator's real demo tenant, so anything a spec creates and does
 * not remove accumulates in a screen a human actually looks at — the fee-head debris (F9) was
 * exactly this, 23 junk entries in a live dropdown. Best-effort by design: a failed cleanup
 * must not fail an otherwise-passing test, but it must be *attempted*.
 */
export async function apiSetupDelete(page: Page, path: string): Promise<void> {
  // ⚠️ The WHOLE body is best-effort, not just the request. This runs from a `finally`, so when the
  // test has already failed the context may be closing — and `page.context().cookies()` then throws
  // `Target page, context or browser has been closed`, which Playwright reports **instead of** the
  // assertion that actually failed. Cleanup must never be the loudest thing in a failure.
  try {
    const cookies = await page.context().cookies();
    const csrf = cookies.find((c) => c.name === 'csrf')?.value ?? '';
    await page.request.delete(`/api/v1${path}`, {
      headers: { 'X-CSRF-Token': csrf },
    });
  } catch {
    // The tenant teardown sweeps anything left behind.
  }
}

/** Authenticated same-origin GET for test setup (reads seed ids like the current year). */
export async function apiSetupGet<T = unknown>(page: Page, path: string): Promise<T> {
  const res = await page.request.get(`/api/v1${path}`);
  if (!res.ok()) throw new Error(`Setup GET ${path} failed: ${res.status()} ${await res.text()}`);
  return res.json() as Promise<T>;
}

const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;

/**
 * A recent date safe for attendance marking: not in the future, and not one of **this school's**
 * weekly-off days. Returned as YYYY-MM-DD (UTC), matching the screen's `<input type="date">`.
 *
 * ⚠️ **It reads the school's setting instead of assuming SUNDAY.** The previous version walked
 * back only over `getUTCDay() === 0`, with a comment asserting "the school's default weekly-off
 * (SUNDAY)". The demo tenant is configured **SUNDAY and SATURDAY**, so from a Saturday this
 * returned that same Saturday, the backend correctly refused to mark a register on a weekly off,
 * and the failure read as "saving attendance is broken" — a test asserting a configuration the
 * tenant never had. The product was right, exactly as with the attendance timezone cases.
 *
 * ⚠️ **Closures are consulted too, and that is not belt-and-braces.** A first version skipped only
 * weekly offs, on the argument that a holiday landing on the chosen day was a remote edge case.
 * It failed on the very next run: walking back off Saturday landed on **14 August**, Pakistan's
 * Independence Day, which is seeded and permanent. "Rare" and "every year on a fixed date" are
 * not the same thing. The date has to be one the backend will actually accept, and the backend
 * refuses both kinds of non-working day — so both are checked here.
 */
export async function safeAttendanceDate(page: Page): Promise<string> {
  const settings = await apiSetupGet<{ weeklyOffDays: string[] }>(page, '/school-settings');
  const off = new Set(settings.weeklyOffDays ?? ['SUNDAY']);
  // School-wide closures and this tenant's campus ones alike: any row whose date matches is a day
  // the register cannot be marked on without an override.
  const holidays = await apiSetupGet<{ date: string }[]>(page, '/holidays');
  const shut = new Set(holidays.map((h) => h.date.slice(0, 10)));

  const d = new Date();
  // 14 steps, not 7: a weekly off can sit next to a multi-day Eid break, and a fortnight back is
  // still "recent" for a register. Throwing beats returning a date the API will reject, because
  // the rejection surfaces as "saving attendance is broken" three assertions later.
  for (let i = 0; i < 14; i++) {
    const iso = d.toISOString().slice(0, 10);
    if (!off.has(WEEKDAYS[d.getUTCDay()]) && !shut.has(iso)) return iso;
    d.setUTCDate(d.getUTCDate() - 1);
  }
  throw new Error('safeAttendanceDate: no working day in the last 14 days for this school');
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
export const E2E_CAMPUS_NAME = 'E2E Automation';
export const E2E_OFFICER_EMAIL = 'e2e.officer@demo.pk';
export const E2E_OFFICER_PASSWORD = 'E2eOfficer!Secret12';

/**
 * The campus this suite owns, created once and reused.
 *
 * Everything here lands on a **separate campus** rather than the school's real ones, because the
 * suite needs an `ADMISSION_CONTROLLER` (admitting is officer-only) and that is a **seat role** —
 * one holder per campus, enforced by a partial unique index. Nominating an officer on a real
 * campus would evict whoever holds the seat, on every run. Its own campus has its own free seat,
 * so nothing of the school's is touched.
 *
 * Idempotent: campus names are unique per school, so this is find-then-create, and repeated runs
 * reuse the same campus instead of accumulating one per run.
 */
export async function e2eCampusId(page: Page): Promise<string> {
  const campuses = await apiSetupGet<{ id: string; name: string }[]>(page, '/campuses');
  const found = campuses.find((c) => c.name.toLowerCase() === E2E_CAMPUS_NAME.toLowerCase());
  if (found) return found.id;
  const created = await apiSetupPost<{ id: string }>(page, '/campuses', { name: E2E_CAMPUS_NAME });
  return created.id;
}

/**
 * The admission officer for that campus — find-then-create, same reasoning as above.
 * Returns credentials rather than a session so the caller can open its own request context and
 * leave the owner's `storageState` untouched.
 */
export async function e2eOfficer(page: Page): Promise<{ email: string; password: string }> {
  const envEmail = process.env.E2E_ADMISSION_OFFICER_EMAIL;
  const envPassword = process.env.E2E_ADMISSION_OFFICER_PASSWORD;
  // An explicitly nominated officer still wins — a CI tenant may prefer to supply its own.
  if (envEmail && envPassword) return { email: envEmail, password: envPassword };

  const users = await apiSetupGet<{ id: string; email: string }[]>(page, '/users');
  if (!users.some((u) => u.email === E2E_OFFICER_EMAIL)) {
    await apiSetupPost(page, '/users', {
      email: E2E_OFFICER_EMAIL,
      password: E2E_OFFICER_PASSWORD,
      roles: ['ADMISSION_CONTROLLER'],
      campusId: await e2eCampusId(page),
    });
  }
  return { email: E2E_OFFICER_EMAIL, password: E2E_OFFICER_PASSWORD };
}

export const E2E_CLASS_NAME = 'E2E Class';
export const E2E_SUBJECT_NAME = 'E2E Subject';

/** Fetch a list and reuse the row with this name, or create it. */
async function findOrCreate<T extends { id: string; name: string }>(
  page: Page, path: string, name: string, create: () => Promise<T>, list?: string,
): Promise<T> {
  const rows = await apiSetupGet<T[]>(page, list ?? path);
  const hit = rows.find((r) => r.name === name);
  return hit ?? (await create());
}

/**
 * The suite's own class, **found or created — not a new one per run**.
 *
 * ⚠️ **It used to be `Cls${Date.now()}`, and the demo tenant reached 185 of them against 3 real
 * classes.** They were accepted as harmless because they sat "in a campus nobody looks at" — until
 * the Cover and student-Move screens began listing every class in the school, at which point every
 * class picker in the app was 98% test debris. Nothing enforced a ceiling, because nothing could:
 * the count grew with how often the suite ran, not with how much was built.
 *
 * Students are still created per run (`Student <ts>` in `seedClassSectionStudent`), but the global
 * teardown now removes those records as well as withdrawing them — the ones it must leave are those
 * carrying payment or certificate history, which the product itself refuses to delete.
 *
 * `scratch: true` opts OUT of the shared class and mints a private, throwaway one.
 *
 * ⚠️ **Reuse and mutation cannot share a fixture.** Most specs only READ the class, so one stable
 * copy suits them. But a spec that renames the subject, adds another, and rewrites what a section
 * studies leaves the fixture altered for whoever runs next — and its own opening assertions
 * ("unassigned", "1 subject without a teacher") only hold against a pristine class. Such a spec
 * must own its class outright and delete it in a `finally`; that is what `scratch` is for. Its
 * name still carries a timestamp, which is fine precisely BECAUSE it is deleted — the 185 leaked
 * classes came from timestamped names that nothing ever removed, not from timestamps as such.
 *
 * `name` gives a spec its OWN stable class. ⚠️ **One shared class across all specs does not work.**
 * The first attempt handed every spec the same one and four specs went red at once: the exam roster
 * loaded another spec's child, the move spec found its old section still occupied, and the fee specs
 * read totals and batches left by their neighbours. Freshness had been doing the isolation work
 * silently, and reuse removed it. A class per spec keeps both properties — isolation, and a count
 * that is fixed at nine rather than growing by one every run.
 */
export async function seedClassSection(
  page: Page, opts?: { scratch?: boolean; name?: string },
): Promise<SeededClass> {
  const campusId = await e2eCampusId(page);
  const base = opts?.name ?? E2E_CLASS_NAME;
  const className = opts?.scratch ? `${base} ${Date.now()}` : base;

  const existing = await apiSetupGet<{ id: string; name: string; order: number; campusId: string }[]>(page, '/classes');
  const mine = existing.filter((k) => k.campusId === campusId);
  const klass = mine.find((k) => k.name === className) ?? await apiSetupPost<{ id: string; name: string }>(
    page, '/classes',
    { campusId, name: className, order: Math.max(0, ...mine.map((k) => k.order)) + 1 },
  );

  const subject = await findOrCreate(page, '/subjects', E2E_SUBJECT_NAME,
    () => apiSetupPost<{ id: string; name: string }>(page, '/subjects', { classId: klass.id, name: E2E_SUBJECT_NAME }),
    `/subjects?classId=${klass.id}`);

  const section = await findOrCreate(page, '/sections', 'A',
    () => apiSetupPost<{ id: string; name: string }>(page, '/sections', { classId: klass.id, name: 'A', capacity: 40 }),
    `/sections?classId=${klass.id}`);

  return {
    className, sectionName: 'A', subjectName: E2E_SUBJECT_NAME, campusId,
    classId: klass.id, sectionId: section.id, subjectId: subject.id,
  };
}

/**
 * As above, plus an admitted student — for specs that need an enrolled child (attendance,
 * fees, reports, CSV import).
 *
 * ⚠️ Admitting is **`ADMISSION_CONTROLLER`-only** by an explicit product decision (segregation
 * of duties): the owner session every other spec uses is 403 on `POST /students`.
 *
 * The officer is the suite's own, on the suite's own campus (see `e2eOfficer`), so the seat it
 * holds is never one the school cares about. `E2E_ADMISSION_OFFICER_EMAIL` /
 * `E2E_ADMISSION_OFFICER_PASSWORD` still override it if you want to nominate someone.
 */
export async function seedClassSectionStudent(
  page: Page, opts?: { scratch?: boolean; name?: string },
): Promise<SeededClassWithStudent> {
  const seeded = await seedClassSection(page, opts);
  const { email, password } = await e2eOfficer(page);

  const ts = Date.now();
  const studentName = `Student ${ts}`;
  // A separate request context so the owner's storageState session is left untouched.
  //
  // ⚠️ **This logs in, and eight specs call this helper** — so a full run makes roughly THIRTEEN
  // logins, not the "~2 per run" the storageState setup projects were built to guarantee. Sharing
  // an officer session (a third setup project) is still the right shape.
  //
  // What is NOT true is that this is currently tripping anything: measured 2026-08-11, seven
  // consecutive logins returned 200 with `RATE_LIMIT_ENABLED` set BOTH ways, after an API restart
  // and a Redis flush. The §29 login limit does not fire against this dev server and **why is
  // unresolved**. Do not repeat the earlier claim that it does — see Key Decisions.
  const officer = await request.newContext({ baseURL: 'http://localhost:3005' });
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
