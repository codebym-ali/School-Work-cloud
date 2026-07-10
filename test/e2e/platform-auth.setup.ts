import { test as setup } from '@playwright/test';
import { platformLogin, PLATFORM_STORAGE_STATE } from './helpers';

/**
 * Setup project for the vendor console — authenticates the platform admin ONCE per run
 * and saves the session to `PLATFORM_STORAGE_STATE`. `admin.spec.ts` reuses it (via
 * `test.use({ storageState })`) so the suite spends only one extra login here, keeping
 * the total under the §29 login limiter (5/IP/15min).
 */
setup('authenticate platform admin', async ({ page }) => {
  await platformLogin(page);
  await page.context().storageState({ path: PLATFORM_STORAGE_STATE });
});
