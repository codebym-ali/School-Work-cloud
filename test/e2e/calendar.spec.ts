import { test, expect } from '@playwright/test';
import { gotoApp, apiSetupGet, apiSetupDelete } from './helpers';

/**
 * The school calendar (H1) — where a closure is actually declared.
 *
 * The service rules are asserted in `m6.e2e` and `campus-scope.e2e`. What the browser proves is
 * the part that decides whether the feature is safe to hand over: that the screen **says it does
 * not notify anyone**, and that it states the consequence nobody expects — a closure changes the
 * payroll working-day count.
 *
 * It creates a dated closure well into the future and removes it in a `finally`, so it never
 * touches a day the school is actually operating.
 */
test.describe('school calendar', () => {
  const FUTURE = '2027-03-19';
  const NAME = 'E2E calendar closure';

  test('declares a closure, states what it does and does not do, then removes it', async ({ page }) => {
    await gotoApp(page);

    // Reachable the way an admin would find it, not by typing the URL.
    await page.getByRole('link', { name: 'School calendar' }).click();
    await page.waitForURL('**/calendar');
    await expect(page.getByRole('heading', { name: 'School calendar' })).toBeVisible();

    // The two sentences the whole free-notification decision rests on.
    await expect(page.getByText(/does not message anyone/i)).toBeVisible();
    await expect(page.getByText(/payroll counts one fewer working day/i)).toBeVisible();

    try {
      await page.locator('label:text-is("Date") + input').fill(FUTURE);
      await page.locator('label:text-is("Why is it closed?") + input').fill(NAME);
      await page.getByRole('button', { name: 'Add closure' }).click();

      const row = page.locator('.card .row', { hasText: NAME });
      await expect(row).toBeVisible();
      // Assert the DATE renders, not just the name. The first version of this spec checked only
      // the name and passed while every row displayed "Invalid Date" — the API returns a full ISO
      // timestamp and the formatter was appending a time to it. A row nobody can read is not a row.
      // Locale-agnostic: assert the day and month are THERE, not a particular arrangement of them.
      await expect(row).toContainText('19');
      await expect(row).toContainText('Mar');
      await expect(row).not.toContainText('Invalid');
      // Every closure says who it applies to — a school-wide one and a campus one are very
      // different facts, and the row must not leave the reader guessing.
      await expect(row.getByText('Whole school')).toBeVisible();

      // Copy message: the free path to families, since guardians have no logins.
      await expect(row.getByRole('button', { name: /Copy message/ })).toBeVisible();

      // Removing is behind a confirm that names the consequence, because deleting a closure
      // re-opens the day: registers get expected again and payroll counts it.
      await row.getByRole('button', { name: 'Delete' }).click();
      await expect(page.getByText(/becomes a normal school day again/i)).toBeVisible();
      await page.getByRole('button', { name: 'Remove closure' }).click();
      await expect(page.locator('.card .row', { hasText: NAME })).toHaveCount(0);
    } finally {
      // Belt and braces: if an assertion failed mid-way, do not leave a closure on the calendar.
      const rest = await apiSetupGet<Array<{ id: string; name: string }>>(page, '/holidays').catch(() => []);
      for (const h of rest.filter((x) => x.name === NAME)) {
        await apiSetupDelete(page, `/holidays/${h.id}`);
      }
    }
  });
});
