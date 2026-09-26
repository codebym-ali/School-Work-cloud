import { test, expect } from '@playwright/test';
import { signIn, world } from './qa-world';

/**
 * AssignCampus — the "Needs a campus" repair control (Campus Hub; the §2 gap that needed a
 * campus-less fixture). A campus-scoped login with no campus sees nothing on its screens; the owner
 * repairs it by assigning a campus. The API is MFA-gated, and the QA owner is enrolled, so this
 * exercises the full assign — not just the gate.
 */
test('AssignCampus — the owner assigns a campus to a mis-configured login and it clears', async ({ browser }) => {
  const w = world();
  const { page, context } = await signIn(browser, 'owner');
  try {
    await page.goto('/campuses');

    // The card only appears when a campus-scoped role has no campus — our orphan teacher.
    const card = page.locator('.card', { hasText: 'Needs a campus' });
    await expect(card).toBeVisible();
    const row = card.locator('tr', { hasText: w.campusLessUser.email });
    await expect(row).toBeVisible();
    await expect(row.getByText('no campus')).toBeVisible();

    // Assign it to Campus A. The owner is two-factor enrolled, so the gated PATCH succeeds.
    await row.getByLabel('Campus').selectOption({ label: w.campusA.name });
    await row.getByRole('button', { name: 'Assign' }).click();

    // Confirmed, and the row leaves the "Needs a campus" list once it has a campus.
    await expect(page.locator('.toast.ok')).toContainText(new RegExp(`Assigned to ${w.campusA.name}`, 'i'));
    await expect(card.locator('tr', { hasText: w.campusLessUser.email })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
