import { test, expect } from '@playwright/test';
import { gotoApp, fieldInput, fieldSelect } from './helpers';

/**
 * Campuses screen (§23) against the live stack: each campus shows its users grouped by role
 * with a per-campus login link; the owner adds a campus-admin login inline, and duplicate
 * campus names are rejected.
 */
test.describe('campuses', () => {
  test('owner adds a campus-admin under a campus; duplicate campus name is rejected', async ({ page }) => {
    const email = `ca${Date.now()}@demo.pk`;
    await gotoApp(page, '/campuses');

    // A per-campus login link is shown automatically.
    await expect(page.getByText('Login link:').first()).toBeVisible();

    // Add a campus admin inline under the first campus.
    await page.getByRole('button', { name: '+ Add user' }).first().click();
    const form = page.locator('.card').filter({ has: page.getByRole('button', { name: /Create login for/ }) }).first();
    await fieldInput(form, 'Email').fill(email);
    await fieldSelect(form, 'Role').selectOption('CAMPUS_ADMIN');
    await fieldInput(form, 'Initial password').fill('CampusPass12345');
    await form.getByRole('button', { name: /Create login for/ }).click();

    await expect(page.locator('.toast.ok')).toContainText(/can now sign in/i);
    // The new user is listed under the campus's "Campus Admins" group (target the cell, not
    // the success toast which also contains the email).
    await expect(page.getByRole('cell', { name: email })).toBeVisible();

    // Duplicate campus name → clean rejection (names are unique per school).
    await page.locator('label:text-is("New campus name") + input').fill('Main Campus');
    await page.getByRole('button', { name: 'Add campus' }).click();
    await expect(page.locator('.toast.err')).toContainText(/already exists/i);
  });
});
