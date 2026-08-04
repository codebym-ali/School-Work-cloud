import { test, expect } from '@playwright/test';
import { gotoApp, apiSetupGet } from './helpers';

/**
 * The verification queue.
 *
 * The rules live in `fees.e2e-spec` against the service; what the browser proves is that the
 * screen states the thing the whole design depends on — **nothing here counts as paid until
 * someone verifies it** — and that the queue is reachable from the sidebar rather than being a
 * route only its author knows about.
 *
 * It creates no claims: this is the operator's demo tenant, and verifying one issues a real
 * receipt against a real invoice, which is immutable afterwards.
 */
test.describe('payment submissions', () => {
  test('the queue is reachable, filters by state, and says nothing is paid until verified', async ({ page }) => {
    await gotoApp(page);

    // Reachable the way a cashier would find it, not by typing the URL.
    await page.getByRole('link', { name: 'Payment submissions' }).click();
    await page.waitForURL('**/fee-claims');

    await expect(page.getByRole('heading', { name: 'Payment submissions' })).toBeVisible();
    // The claim/payment distinction is the point of the screen, so it is stated on it.
    await expect(page.getByText(/Nothing here is counted as paid/i)).toBeVisible();

    // Three states, defaulting to the one that needs a human.
    await expect(page.getByRole('button', { name: /Awaiting check/ })).toBeVisible();
    for (const label of ['Verified', 'Rejected', 'Awaiting check']) {
      await page.getByRole('button', { name: new RegExp(label) }).click();
      await expect(page.locator('.card')).toBeVisible();
    }

    // An empty queue says so plainly rather than showing a bare table.
    const rows = page.locator('table tbody tr');
    if (await rows.count() === 0) {
      await expect(page.getByText(/Nothing is waiting to be checked/i)).toBeVisible();
    }
  });

  test('the pending count the dashboard advertises matches the queue', async ({ page }) => {
    await gotoApp(page);
    const { pending } = await apiSetupGet<{ pending: number }>(page, '/fees/claims/pending-count');

    const chip = page.getByRole('link', { name: /payments? awaiting verification/ });
    if (pending > 0) {
      // A chip that points at a page which cannot act on it is worse than no chip — this one
      // both counts correctly and lands somewhere the cashier can decide.
      await expect(chip).toContainText(String(pending));
      await chip.click();
      await page.waitForURL('**/fee-claims');
    } else {
      await expect(chip).toHaveCount(0);
    }
  });
});
