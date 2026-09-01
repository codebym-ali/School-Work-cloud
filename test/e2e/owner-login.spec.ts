import { test, expect } from '@playwright/test';
import { E2E_OFFICER_EMAIL, E2E_OFFICER_PASSWORD } from './helpers';

/**
 * The owner's own door (Owner Login Plan, O0/O1), now on the Owner app's **own origin**.
 *
 * ⚠️ **Since the front-end split the door is `owner-web:3005/login`, not `apps/web/owner-login`.**
 * Each audience has its own single-door app, so the door no longer carries cross-links to the
 * others — the choosing happens one level up, on the apex marketing chooser (`apps/web:3001/login`),
 * which now points at each app by its own origin. This spec covers both: the owner door works
 * (against the default owner-web `baseURL`), and the chooser routes each audience to the right app.
 *
 * Runs without the shared owner session on purpose — this spec is about *reaching* a session, so
 * it must start signed out.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('owner login door', () => {
  test('the owner signs in at their own door', async ({ page }) => {
    // The default project baseURL is owner-web (:3005); `/login` there IS the owner door (a direct
    // form), not the marketing chooser.
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: /School owner/ })).toBeVisible();

    await page.locator('#email').fill('owner@demo.pk');
    await page.locator('#password').fill('Owner!Secret12');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Lands where an owner belongs — the door changes nothing about the world behind it.
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('the marketing chooser points each audience at its own app', async ({ page }) => {
    // The chooser stays on the apex marketing app (:3001) — the redirect target for every 401 and
    // logout. Since the split it cannot itself be a door: at that point the visitor is signed out,
    // nothing knows their role, and the per-audience apps refuse each other's people. So it names
    // the options and links CROSS-ORIGIN to each app's own door (dev: the local ports).
    await page.goto('http://localhost:3001/login');
    await expect(page.getByRole('link', { name: /School owner/ })).toHaveAttribute('href', 'http://localhost:3005/login');
    await expect(page.getByRole('link', { name: /School staff/ })).toHaveAttribute('href', 'http://localhost:3006/login');
    await expect(page.getByRole('link', { name: /Student/ })).toHaveAttribute('href', 'http://localhost:3003/login');
  });

  test('a non-owner is refused, and told nothing that identifies the owner', async ({ page }) => {
    // The e2e admission officer is a real, working credential — with the WRONG role for this door.
    // Taken from the helpers rather than retyped: a hardcoded copy would drift from the seeding and
    // this test would then pass for the wrong reason (refused because the password was wrong).
    await page.goto('/login');
    await page.locator('#email').fill(E2E_OFFICER_EMAIL);
    await page.locator('#password').fill(E2E_OFFICER_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Still on the door, no session.
    await expect(page).toHaveURL(/\/login/);
    const shown = await page.locator('.error').textContent();

    // ⚠️ The message must not distinguish "wrong role" from "wrong password" — asserted by
    // comparing it against a genuinely wrong password for the same account.
    await page.locator('#password').fill('DefinitelyNotThePassword!9');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('.error')).toHaveText(shown ?? '');
  });
});
