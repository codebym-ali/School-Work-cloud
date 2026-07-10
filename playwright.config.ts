import { defineConfig, devices } from '@playwright/test';
import { STORAGE_STATE } from './test/e2e/helpers';

/**
 * Playwright config for the frontend E2E smoke/flow suite (blueprint frontend work).
 * Assumes the dev stack (API :3000, web :3001, docker infra) is already running —
 * see CLAUDE.md "Common commands". No webServer block on purpose: these specs are
 * meant to be run against the live dev stack, not a freshly spawned one.
 *
 * Auth is shared via a setup project (`auth.setup.ts`) that logs in once and writes
 * `STORAGE_STATE`; the chromium project reuses it. That keeps the whole suite to ~2
 * form logins so it stays under the §29 login rate limiter (5/IP/15min).
 */
export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3001',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE },
      dependencies: ['setup'],
    },
  ],
});
