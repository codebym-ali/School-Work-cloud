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
      await expect(page.getByText(/owner@demo\.pk/)).toBeVisible();
    });
  });

  test('sidebar shows OWNER_ADMIN nav items', async ({ page }) => {
    await gotoApp(page);
    const sidebar = page.locator('.sidebar');
    for (const label of ['Dashboard', 'Setup', 'Students', 'Admissions', 'Attendance', 'Fees', 'Exams', 'Reports']) {
      await expect(sidebar.getByRole('link', { name: label, exact: true })).toBeVisible();
    }
  });

  test('Students screen shows the table', async ({ page }) => {
    await gotoApp(page, '/students');
    await expect(page.locator('table')).toBeVisible();
    await expect(page.locator('table thead')).toContainText('GR');
  });
});
