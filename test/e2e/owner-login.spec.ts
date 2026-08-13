import { test, expect } from '@playwright/test';
import { E2E_OFFICER_EMAIL, E2E_OFFICER_PASSWORD } from './helpers';

/**
 * The owner's own door (Owner Login Plan, O0/O1).
 *
 * Runs without the shared owner session on purpose — this spec is about *reaching* a session, so
 * it must start signed out.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('owner login door', () => {
  test('the owner signs in at their own door, and the doors point at each other', async ({ page }) => {
    await page.goto('/owner-login');
    await expect(page.getByRole('heading', { name: /School owner/ })).toBeVisible();

    // ⚠️ The way out is on the page BEFORE anyone fails. It has to be: the refusal is
    // indistinguishable from a wrong password by design, so a mis-routed teacher gets no hint
    // from the error and this link is the only thing that can redirect them.
    await expect(page.getByRole('link', { name: /Sign in with your email/ })).toBeVisible();

    // …and the staff door names this one, so an owner can find it without being told.
    // The prompt ("School owner?") sits OUTSIDE the anchor, so the link's accessible name is only
    // "Sign in here →" — assert the two separately rather than as one phrase.
    await page.goto('/login');
    await expect(page.getByText(/School owner\?/)).toBeVisible();
    await expect(page.getByRole('link', { name: /Sign in here/ })).toHaveAttribute('href', '/owner-login');

    await page.goto('/owner-login');
    await page.locator('#email').fill('owner@demo.pk');
    await page.locator('#password').fill('Owner!Secret12');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Lands where an owner belongs — the door changes nothing about the world behind it.
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('a non-owner is refused, and told nothing that identifies the owner', async ({ page }) => {
    // The e2e admission officer is a real, working credential — with the WRONG role for this door.
    // Taken from the helpers rather than retyped: a hardcoded copy would drift from the seeding and
    // this test would then pass for the wrong reason (refused because the password was wrong).
    await page.goto('/owner-login');
    await page.locator('#email').fill(E2E_OFFICER_EMAIL);
    await page.locator('#password').fill(E2E_OFFICER_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Still on the door, no session.
    await expect(page).toHaveURL(/\/owner-login/);
    const shown = await page.locator('.error').textContent();

    // ⚠️ The message must not distinguish "wrong role" from "wrong password" — asserted by
    // comparing it against a genuinely wrong password for the same account.
    await page.locator('#password').fill('DefinitelyNotThePassword!9');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('.error')).toHaveText(shown ?? '');
  });
});
