import { test, expect } from '@playwright/test';
import { gotoApp, apiSetupGet, apiSetupPost, apiSetupDelete } from './helpers';

/**
 * The closure banner in the app shell (H2).
 *
 * The whole reason it lives in the shell rather than on a dashboard is that **teachers do not
 * have a dashboard** — `/dashboard` is owner/campus-admin/accountant only. So what the browser
 * has to prove is that the notice appears on a page that is NOT the dashboard, which is the case
 * a unit test cannot express.
 *
 * It declares a real closure for today and removes it in a `finally`: today's closure silences
 * the whole school's registers, and leaving one behind would be the worst kind of test debris.
 */
test.describe('closure banner', () => {
  test('a declared closure is named on every page, not just the dashboard', async ({ page }) => {
    await gotoApp(page);
    const today = new Date().toISOString().slice(0, 10);

    // Not the demo tenant's own calendar: create ours, and take it away again.
    const closure = await apiSetupPost<{ id: string }>(page, '/holidays', {
      date: today,
      name: 'E2E emergency closure',
    });

    try {
      // The dashboard, where an admin would see it.
      await page.reload();
      await expect(page.getByText(/E2E emergency closure/)).toBeVisible();
      await expect(page.getByText(/no attendance is taken/i)).toBeVisible();

      // And — the point of putting it in the shell — a page that is not the dashboard. This is
      // where a teacher actually lands.
      await page.goto('/attendance');
      await expect(page.getByText(/E2E emergency closure/)).toBeVisible();

      // The screens that already asked "is this a working day" now say WHICH day and why,
      // instead of the old generic "holiday or weekly off".
      await page.goto('/my-attendance');
      await expect(page.getByText(/E2E emergency closure/)).toBeVisible();
    } finally {
      await apiSetupDelete(page, `/holidays/${closure.id}`);
    }

    // Gone again: the banner is not sticky, and the school is open tomorrow.
    await page.goto('/dashboard');
    await expect(page.getByText(/E2E emergency closure/)).toHaveCount(0);

    // And nothing of ours is left on the calendar.
    const rest = await apiSetupGet<Array<{ name: string }>>(page, '/holidays');
    expect(rest.some((h) => h.name === 'E2E emergency closure')).toBe(false);
  });
});
