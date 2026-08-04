import { test, expect } from '@playwright/test';
import { login, gotoApp } from './helpers';

test.describe('smoke', () => {
  // The login-flow test must start logged OUT (it verifies the form itself), so it
  // opts out of the shared storageState and does a real form login.
  test.describe('login flow', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('owner login lands on dashboard', async ({ page }) => {
      await login(page);
      await expect(page).toHaveURL(/\/dashboard$/);
      // `.first()`: the address renders in the top bar AND in the dashboard's greeting line, and
      // the greeting appears only once `me` has loaded — so a strict match was a timing coin-flip.
      await expect(page.getByText(/owner@demo\.pk/).first()).toBeVisible();
    });
  });

  /**
   * The labels below are a hand-kept copy of `NAV` in `apps/web/lib/roles.ts`, so a rename there
   * breaks this spec rather than the app — which is exactly what happened: `Setup` became
   * **School configuration** and this sat red, asserting a link that no longer exists.
   *
   * `Admissions` is deliberately NOT in the list. It is hidden from an owner in a **DIRECT**
   * school (no enquiry pipeline ⇒ the page is a dead end for everyone but the officer), and the
   * demo tenant is DIRECT — so requiring it here would assert a bug back into existence.
   */
  test('sidebar shows OWNER_ADMIN nav items', async ({ page }) => {
    await gotoApp(page);
    const sidebar = page.locator('.sidebar');
    for (const label of ['Dashboard', 'Students', 'Classes', 'Attendance', 'Fees', 'Exams & Results', 'Reports', 'School configuration']) {
      await expect(sidebar.getByRole('link', { name: label, exact: true })).toBeVisible();
    }
  });

  test('Students screen shows the table', async ({ page }) => {
    await gotoApp(page, '/students');
    await expect(page.locator('table')).toBeVisible();
    await expect(page.locator('table thead')).toContainText('GR');
  });
});
