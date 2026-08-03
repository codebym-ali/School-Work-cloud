import { test, expect } from '@playwright/test';
import { gotoApp, apiSetupGet, apiSetupPost, seedClassSection } from './helpers';

interface Year { id: string; isCurrent: boolean }

/**
 * The fee plan screen.
 *
 * Scope is deliberate: the MUTATIONS (create, edit-while-unbilled, refuse-once-billed, copy,
 * duplicate 409) are covered by `fees.e2e-spec.ts` against the real service, where they can be
 * asserted precisely and quickly. What only the browser can prove is the thing the old screen
 * could not do at all — **show what a class costs** — so that is what this drives, with the
 * fixture seeded through the API rather than typed through the DOM.
 */
test.describe('fee plan', () => {
  test('shows a class’s monthly total on Fees and on the class workbench', async ({ page }) => {
    test.setTimeout(60_000);
    await gotoApp(page);

    const years = await apiSetupGet<Year[]>(page, '/academic-years');
    const year = years.find((y) => y.isCurrent);
    test.skip(!year, 'no current academic year on this tenant');

    const { classId, className } = await seedClassSection(page);
    const tuition = await apiSetupPost<{ id: string }>(page, '/fee-heads', { name: `Tuition-${Date.now()}` });
    const transport = await apiSetupPost<{ id: string }>(page, '/fee-heads', { name: `Transport-${Date.now()}` });

    try {
      // Two heads, so the total is a SUM and not just an echo of one row — the question
      // "what does this class cost?" is exactly the one a single figure could not answer.
      for (const [head, amount] of [[tuition.id, 3000], [transport.id, 1000]] as const) {
        await apiSetupPost(page, '/fee-structures', {
          classId, feeHeadId: head, academicYearId: year!.id, amount, frequency: 'MONTHLY',
        });
      }

      await page.goto('/fees');
      await page.getByRole('button', { name: /Fee setup/ }).click();

      // Narrowed by the Manage button: the class name also appears in the panel's
      // "classes with no fees" warning and in the invoice-generation dropdown.
      // `Manage|Hide` because the button flips label when the card expands — filtering on
      // "Manage" alone stops matching the moment it is clicked.
      const card = page.locator('.card')
        .filter({ hasText: className })
        .filter({ has: page.getByRole('button', { name: /^(Manage|Hide)$/ }) });
      await expect(card).toContainText('Rs 4,000');
      await expect(card).toContainText('per month');

      await card.getByRole('button', { name: 'Manage' }).click();
      await expect(card).toContainText('Rs 3,000');
      await expect(card).toContainText('Rs 1,000');

      // The same figure on the class workbench, read-only — "what does 9th cost?" now sits
      // beside "who teaches it?" instead of on another screen entirely.
      await page.goto(`/classes/${classId}`);
      await expect(page.getByText('Rs 4,000')).toBeVisible();
    } finally {
      const cookies = await page.context().cookies();
      const csrf = cookies.find((c) => c.name === 'csrf')?.value ?? '';
      const del = (p: string) => page.request.delete(`http://localhost:3001/api/v1${p}`, { headers: { 'X-CSRF-Token': csrf } });
      for (const s of await apiSetupGet<{ id: string }[]>(page, `/fee-structures?classId=${classId}`)) await del(`/fee-structures/${s.id}`);
      for (const s of await apiSetupGet<{ id: string; classId: string }[]>(page, '/sections')) {
        if (s.classId === classId) await del(`/sections/${s.id}`);
      }
      for (const s of await apiSetupGet<{ id: string }[]>(page, `/subjects?classId=${classId}`)) await del(`/subjects/${s.id}`);
      await del(`/classes/${classId}`);
    }
  });
});
