import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { authenticator } from 'otplib';

/**
 * The QA world: one disposable school, provisioned per run, that the Owner Gaps QA Test Plan executes against.
 *
 * ⚠️ **Why not the demo school.** Most of what this plan tests is two-factor gated (reversal, waiver, payroll
 * approval, marking salaries paid). Enrolling the demo owner would lock whoever uses the demo by hand behind a code
 * they do not have. A throwaway `qa<stamp>` school carries its own enrolled accounts and is removed by the
 * global teardown (`^(admin-|qa)[0-9]+$`).
 *
 * ⚠️ **Tenant by hostname.** owner-web and staff-web proxy `/api` to `<tenant>.localhost:4000` from the request's
 * Host, so the browser only has to visit `http://qa<stamp>.localhost:3005`. Chromium resolves `*.localhost` to
 * loopback; Node does not reliably, which is why setup talks to the API with an explicit Host header and browser
 * sessions sign in with `fetch` from inside the page.
 */
export const WORLD_FILE = 'test/e2e/.auth/qa-world.json';

export type QaRole = 'owner' | 'campusAdmin' | 'accountantA' | 'accountantB' | 'teacher';

export interface QaWorld {
  subdomain: string;
  schoolId: string;
  password: string;
  campusA: { id: string; name: string };
  campusB: { id: string; name: string };
  nextYearId: string;
  accounts: Record<QaRole, { email: string; door: 'owner' | 'staff'; mfaSecret?: string }>;
  staffIds: Record<string, string>;
  students: Record<'paid' | 'owingWaive' | 'owingWithdraw' | 'noDues' | 'optedOut' | 'campusB', { id: string; name: string }>;
  phones: { optedOut: string };
  /** The section the QA teacher is assigned to mark (C9 attendance-picker scoping). */
  teacherSection: { sectionId: string; label: string };
  /** A campus-scoped login with no campus — the "Needs a campus" repair control (AssignCampus). */
  campusLessUser: { email: string };
}

export const world = (): QaWorld => JSON.parse(readFileSync(WORLD_FILE, 'utf8')) as QaWorld;

export const origin = (w: QaWorld, door: 'owner' | 'staff') =>
  `http://${w.subdomain}.localhost:${door === 'owner' ? 3005 : 3006}`;

/**
 * A signed-in page for one QA role, on that role's door.
 *
 * Signs in with the real endpoints from inside the page (so cookies land on the tenant origin exactly as a person's
 * would), completing the two-factor challenge from the enrolment secret. The form login itself is covered by the
 * existing smoke and owner-login specs; repeating it here would test nothing new.
 */
export async function signIn(browser: Browser, role: QaRole): Promise<{ page: Page; context: BrowserContext }> {
  const w = world();
  const acct = w.accounts[role];
  const context = await browser.newContext({ baseURL: origin(w, acct.door), storageState: { cookies: [], origins: [] } });
  await routeToTenant(context, w);
  const page = await context.newPage();
  await page.goto('/login');
  // ⚠️ A code generated in the last moments of its 30-second window can expire before the server checks it (the
  // API accepts the current window only). Wait out the tail of a window rather than retry a refused sign-in.
  if (acct.mfaSecret && authenticator.timeRemaining() < 5) await page.waitForTimeout((authenticator.timeRemaining() + 1) * 1000);
  const code = acct.mfaSecret ? authenticator.generate(acct.mfaSecret) : null;
  const result = await page.evaluate(async ({ email, password, door, code }) => {
    const path = door === 'owner' ? '/api/v1/auth/owner-login' : '/api/v1/auth/login';
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }), credentials: 'include' });
    const body = await r.json();
    if (body.mfaRequired) {
      const c = await fetch('/api/v1/auth/mfa/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mfaToken: body.mfaToken, code }), credentials: 'include' });
      return c.status === 200 ? 200 : `challenge ${c.status} ${await c.text()}`;
    }
    return r.status === 200 ? 200 : `login ${r.status} ${JSON.stringify(body)}`;
  }, { email: acct.email, password: w.password, door: acct.door, code });
  expect(result, `${role} sign-in`).toBe(200);
  await page.goto('/dashboard');
  await expect(page.locator('.sidebar')).toBeVisible();
  return { page, context };
}

/**
 * Send this context's `/api` calls to the QA school.
 *
 * ⚠️ The dev apps' proxy (`next.config` rewrites) did not match a QA subdomain and fell back to the DEMO school —
 * found building this suite: sign-in answered "invalid credentials" and the API log showed `host: demo.localhost`.
 * Production routes by hostname at the edge, so this is a dev-only gap; the suite forwards the calls itself rather
 * than changing the app for a test. Cookies still round-trip through the browser, exactly as they would behind Traefik.
 */
export async function routeToTenant(context: BrowserContext, w: QaWorld) {
  await context.route(/\/api\/v1\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const headers = { ...req.headers(), host: `${w.subdomain}.localhost` };
    try {
      const response = await route.fetch({ url: `http://localhost:4000${url.pathname}${url.search}`, headers });
      await route.fulfill({ response });
    } catch {
      // The page closed mid-request (a test finished while the app was still polling). Nothing to deliver.
    }
  });
}

/** Same-origin API call from a signed-in page, with the CSRF double-submit header — for setup the UI does not own. */
export async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  return page.evaluate(async ({ method, path, body, extraHeaders }) => {
    const csrf = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/)?.[1] ?? '';
    const r = await fetch(`/api/v1${path}`, {
      method, credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, body: parsed as T };
  }, { method, path, body, extraHeaders }) as Promise<{ status: number; body: T }>;
}

/** Sidebar link names for the signed-in role. */
export async function navLabels(page: Page): Promise<string[]> {
  return page.locator('.sidebar a').evaluateAll((as) => as.map((a) => (a.textContent ?? '').trim()).filter(Boolean));
}
