import { test, expect } from '@playwright/test';

/**
 * Student self-service portal (§28) against the live stack: a STUDENT logs in, lands on
 * their own portal (/me), sees only their read-only screens (not the admin nav), and can
 * open their fees. Uses a fresh form login (opts out of the shared owner storageState).
 */
test.describe('student portal', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('student logs in and sees their own read-only portal', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('student@demo.pk');
    await page.getByLabel('Password').fill('Student!Secret12');
    await page.getByRole('button', { name: /sign in/i }).click();

    await page.waitForURL('**/me');
    await expect(page.getByRole('heading', { name: /welcome/i })).toBeVisible();

    const sidebar = page.locator('.sidebar');
    await expect(sidebar.getByRole('link', { name: 'My Dashboard' })).toBeVisible();
    await expect(sidebar.getByRole('link', { name: 'My Results' })).toBeVisible();
    // Admin screens are NOT offered to a student.
    await expect(sidebar.getByRole('link', { name: 'Setup', exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole('link', { name: 'Students', exact: true })).toHaveCount(0);

    await sidebar.getByRole('link', { name: 'My Fees' }).click();
    await page.waitForURL('**/me/fees');
    await expect(page.getByRole('heading', { name: 'My Fees' })).toBeVisible();
  });
});
