import { test, expect, type Page } from '@playwright/test';

/**
 * The show/hide toggle on every password door.
 *
 * Three things are worth a test here, and only one of them is the feature:
 *
 *  1. **It starts hidden, every time.** The visible state is never persisted — a remembered "show"
 *     would eventually reveal a password to whoever is standing at the school's front counter,
 *     which is exactly where this product is used.
 *  2. ⚠️ **The toggle must not SUBMIT the form.** A `<button>` inside a `<form>` defaults to
 *     `type="submit"`. Get that wrong and clicking "Show" attempts a sign-in with a half-typed
 *     password, which presents as a mysterious failed login rather than as a broken button.
 *  3. ⚠️ **`getByLabel('Password', { exact: true })` must keep working.** The input is now wrapped in a div, and
 *     every e2e login helper in this suite finds the field by its label. If the label/`id` pairing
 *     had broken, the whole suite would fail somewhere far away from the cause.
 *
 * Runs signed out: these are the doors.
 */
test.use({ storageState: { cookies: [], origins: [] } });

async function expectToggleBehaviour(page: Page, doorName: string) {
  const field = page.getByLabel('Password', { exact: true });
  await expect(field, `${doorName}: the label must still resolve the input`).toBeVisible();

  // 1. Masked on arrival.
  await expect(field).toHaveAttribute('type', 'password');

  await field.fill('correct-horse-battery');
  const url = page.url();

  // 2. Reveal — and the form must NOT have been submitted by the click.
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(field).toHaveAttribute('type', 'text');
  await expect(field, 'revealing must not clear what was typed').toHaveValue('correct-horse-battery');
  expect(page.url(), `${doorName}: the toggle submitted the form`).toBe(url);

  // 3. Hide again.
  await page.getByRole('button', { name: 'Hide password' }).click();
  await expect(field).toHaveAttribute('type', 'password');
  await expect(field).toHaveValue('correct-horse-battery');
}

test.describe('password show/hide', () => {
  test('owner door', async ({ page }) => {
    await page.goto('/login'); // default baseURL is owner-web (:3005)
    await expectToggleBehaviour(page, 'owner');
  });

  test('staff door', async ({ page }) => {
    await page.goto('http://localhost:3006/login');
    await expectToggleBehaviour(page, 'staff');
  });

  test('vendor console', async ({ page }) => {
    await page.goto('http://localhost:3004/login');
    await expectToggleBehaviour(page, 'console');
  });

  test('a reload returns to hidden — the state is never remembered', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Password', { exact: true }).fill('temporary');
    await page.getByRole('button', { name: 'Show password' }).click();
    await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');

    await page.reload();
    // The whole point: a password field that stayed readable across a reload would be readable to
    // the next person at the counter.
    await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'password');
  });
});
