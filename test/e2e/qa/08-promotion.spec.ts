import { test, expect, type Page } from '@playwright/test';
import { signIn, world } from './qa-world';

/**
 * PRO-01..03 — year-end promotion (Phase 3.3). Runs last: it moves campus A's students into 2027-28.
 * QA One promotes into QA Two; QA Two is the top class on campus A, so its students complete school.
 */
async function review(page: Page) {
  const w = world();
  await page.goto('/promotion');
  await expect(page.getByRole('heading', { name: 'Year-end promotion' })).toBeVisible();
  const campus = page.locator('#prm-campus');
  if (await campus.count()) await campus.selectOption(w.campusA.id);
  await page.locator('#prm-year').selectOption(w.nextYearId);
  await page.getByRole('button', { name: /Review the list|Refresh list/ }).click();
  await expect(page.getByRole('button', { name: /Promote into 2027-28/ })).toBeVisible();
}
const count = async (page: Page, label: string) =>
  Number(await page.locator('.card.row span', { hasText: new RegExp(`^\\d+ ${label}$`) }).locator('strong').first().innerText());

test.describe.serial('PRO · year-end promotion', () => {
  test('PRO-01 reviewing the list writes nothing', async ({ browser }) => {
    const { page, context } = await signIn(browser, 'owner');
    await review(page);
    const promote = await count(page, 'promote');
    const complete = await count(page, 'complete school');
    expect(promote + complete, 'someone to move').toBeGreaterThan(0);
    await expect(page.locator('details', { hasText: 'QA One' }).first()).toContainText('QA Two');

    // Review again: nobody moved, so the same students are still to be promoted — none "already moved".
    await review(page);
    expect(await count(page, 'promote')).toBe(promote);
    await expect(page.getByText(/already moved/)).toHaveCount(0);
    await context.close();
  });

  test('PRO-02 promoting commits exactly what was reviewed; PRO-03 a second run moves nobody twice', async ({ browser }) => {
    const { page, context } = await signIn(browser, 'owner');
    await review(page);
    const promote = await count(page, 'promote');
    const complete = await count(page, 'complete school');
    await page.getByRole('button', { name: /Promote into 2027-28/ }).click();
    await expect(page.getByRole('dialog')).toContainText('All of it happens together or not at all');
    await page.locator('#reasoned-action-reason').fill('QA PRO-02: year-end promotion approved');
    await page.getByRole('button', { name: 'Promote', exact: true }).click();
    // The dialog closes with the plan it confirmed; the lasting result is the page's summary.
    const done = page.locator('.toast.ok', { hasText: 'Promotion done.' });
    await expect(done).toContainText(`${promote} promoted`);
    await expect(done).toContainText(`${complete} completed school`);

    await review(page);
    // Promoted students now belong to 2027-28, so the list has nobody left to move and the button cannot be pressed.
    expect(await count(page, 'promote'), 'PRO-03: nothing left to promote').toBe(0);
    expect(await count(page, 'complete school')).toBe(0);
    await expect(page.getByRole('button', { name: /Promote into 2027-28/ })).toBeDisabled();
    await context.close();
  });
});
