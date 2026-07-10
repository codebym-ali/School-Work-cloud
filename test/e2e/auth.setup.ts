import { test as setup } from '@playwright/test';
import { login, STORAGE_STATE } from './helpers';

/**
 * Playwright "setup project" — authenticates ONCE per run and saves the session to
 * `STORAGE_STATE`. Every other spec reuses it (config `use.storageState`), so the whole
 * suite costs just this one form login (+ the smoke login-flow test = 2 total), staying
 * under the §29 login limiter (5/IP/15min) even across a few consecutive runs.
 */
setup('authenticate', async ({ page }) => {
  await login(page);
  await page.context().storageState({ path: STORAGE_STATE });
});
