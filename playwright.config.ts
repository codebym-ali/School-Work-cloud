import { defineConfig, devices } from '@playwright/test';
import { STORAGE_STATE } from './test/e2e/helpers';

/**
 * Playwright config for the frontend E2E smoke/flow suite (blueprint frontend work).
 *
 * ⚠️ **Since the front-end split, the school app is served by owner-web, not apps/web.** The default
 * `baseURL` is therefore **owner-web (:3005)** — it serves the entire school app AND the owner door
 * (`/login`) AND proxies `/api` to the demo tenant. Specs that need a different audience override
 * `baseURL` per file: staff/officer specs → staff-web (:3006); the console spec uses the absolute
 * console origin (:3004) via the `platformLogin`/`gotoAdmin` helpers.
 *
 * Assumes the dev stack is already running — for this suite that means **API :4000, owner-web :3005
 * (default baseURL), staff-web :3006, superadmin-web :3004, and apps/web :3001** (the marketing
 * chooser, for the owner-login door spec) (+ docker infra). parent-web :3003 is only needed for the
 * parent-portal spec, which skips unless `E2E_STUDENT_REG_NO`/`E2E_STUDENT_CNIC` are set. No
 * webServer block on purpose: these specs run against the live dev stack, not a freshly spawned one.
 * (On Windows, stop background node before `next build`; run the apps via `next start` to avoid
 * dev-compile latency.)
 *
 * Auth is shared via two setup projects that each log in once and write a storageState:
 * `auth.setup.ts` (tenant owner, on owner-web) and `platform-auth.setup.ts` (platform admin, on the
 * console). Feature specs reuse the tenant session; `admin.spec.ts` overrides to the platform
 * session. So the whole suite spends ~3 form logins (2 setups + the smoke login-flow test), staying
 * under the §29 login rate limiter (5/IP/15min).
 */
export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  // Retires the students this suite admits into its own campus. Without it the test classes
  // accumulate as ACTIVE enrolments and start showing up in the operator's real metrics — the
  // G3 unmarked-register count reached 71, 67 of them ours. See the file for why they are
  // withdrawn rather than deleted.
  globalTeardown: './test/e2e/global-teardown.ts',
  use: {
    baseURL: 'http://localhost:3005',
    trace: 'on-first-retry',
  },
  projects: [
    // Anchor the tenant match to a path boundary so it does NOT also match
    // `platform-auth.setup.ts` (whose name contains the substring `auth.setup.ts`).
    { name: 'setup-tenant', testMatch: /[\\/]auth\.setup\.ts$/ },
    { name: 'setup-platform', testMatch: /platform-auth\.setup\.ts$/ },
    // Owner Gaps QA Test Plan: a disposable school with two-factor-enrolled accounts (test/e2e/qa).
    { name: 'setup-qa', testMatch: /[\\/]qa[\\/]qa\.setup\.ts$/, dependencies: ['setup-platform'] },
    {
      name: 'qa',
      testMatch: /[\\/]qa[\\/].*\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
      // setup-tenant too: AUTH-02/03 read the demo owner's (unenrolled) session.
      dependencies: ['setup-qa', 'setup-tenant'],
    },
    // Accessibility gate (axe-core). Owner session only, so it needs just API + owner-web, not the
    // platform console — cheap enough to run on its own. See test/e2e/a11y.spec.ts.
    {
      name: 'a11y',
      testMatch: /[\\/]a11y\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE },
      dependencies: ['setup-tenant'],
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE },
      dependencies: ['setup-tenant', 'setup-platform'],
      testIgnore: [/[\\/]auth\.setup\.ts$/, /platform-auth\.setup\.ts$/, /[\\/]qa[\\/]/, /a11y\.spec\.ts$/],
    },
  ],
});
