import { test, expect } from '@playwright/test';
import { gotoApp, cardByHeading, fieldInput, fieldSelect } from './helpers';

/**
 * Users & roles (§23) against the live stack: the owner creates a campus-admin login bound
 * to a campus, and it appears in the list. (The created account's ability to actually sign
 * in + campus scoping is proven in users.e2e-spec.ts.)
 */
test.describe('users & roles', () => {
  test('owner creates a campus-admin login bound to a campus', async ({ page }) => {
    const email = `ca${Date.now()}@demo.pk`;

    await gotoApp(page, '/users');
    await page.getByRole('button', { name: '+ New user' }).click();

    const card = cardByHeading(page, 'New user');
    await fieldInput(card, 'Email').fill(email);
    await fieldSelect(card, 'Role').selectOption('CAMPUS_ADMIN');
    await fieldSelect(card, 'Campus').selectOption({ index: 1 }); // first real campus
    await fieldInput(card, 'Initial password').fill('CampusPass12345');
    await card.getByRole('button', { name: 'Create user' }).click();

    await expect(page.locator('.toast.ok')).toContainText(/can sign in/i);
    await expect(page.locator('table')).toContainText(email);
  });
});
