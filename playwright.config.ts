import { defineConfig, devices } from '@playwright/test';
import { STORAGE_STATE } from './test/e2e/helpers';

/**
 * Playwright config for the frontend E2E smoke/flow suite (blueprint frontend work).
 * Assumes the dev stack (API :3000, web :3001, docker infra) is already running —
 * see CLAUDE.md "Common commands". No webServer block on purpose: these specs are
 * meant to be run against the live dev stack, not a freshly spawned one.
 *
 * Auth is shared via two setup projects that each log in once and write a storageState:
 * `auth.setup.ts` (tenant owner) and `platform-auth.setup.ts` (platform admin). Feature
 * specs reuse the tenant session; `admin.spec.ts` overrides to the platform session. So
 * the whole suite spends ~3 form logins (2 setups + the smoke login-flow test), staying
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
    baseURL: 'http://localhost:3001',
    trace: 'on-first-retry',
  },
  projects: [
    // Anchor the tenant match to a path boundary so it does NOT also match
    // `platform-auth.setup.ts` (whose name contains the substring `auth.setup.ts`).
    { name: 'setup-tenant', testMatch: /[\\/]auth\.setup\.ts$/ },
    { name: 'setup-platform', testMatch: /platform-auth\.setup\.ts$/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE },
      dependencies: ['setup-tenant', 'setup-platform'],
      testIgnore: [/[\\/]auth\.setup\.ts$/, /platform-auth\.setup\.ts$/],
    },
  ],
});
