import { test, expect } from '@playwright/test';
import { gotoApp, apiSetupGet, apiSetupPost, seedClassSectionStudent } from './helpers';

/**
 * The guardian upload link, driven the way a parent actually meets it: a URL from an SMS, opened
 * with no account, on a page outside the app shell.
 *
 * The service rules are asserted in `fees.e2e`. What the browser has to prove is the part a unit
 * test cannot: that the page is reachable **signed out**, that it does not leak the child's
 * record, and that it never tells a family their fee is paid when all they have done is submit a
 * screenshot. That last one is the whole design — a claim is not a payment — and it lives or dies
 * in the wording on this page.
 */
test.describe('guardian fee link', () => {
  test('a signed-out guardian sees only their child’s first name, and is not told it is paid', async ({ page, browser }) => {
    await gotoApp(page);

    // Turn the feature on for the run, and put it back afterwards — this is the operator's tenant.
    const before = await apiSetupGet<{ feeSubmission: { guardianUploadLink: boolean } }>(page, '/school-settings');
    const wasOn = before.feeSubmission.guardianUploadLink;

    try {
      if (!wasOn) {
        await page.request.patch('http://localhost:3001/api/v1/school-settings', {
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': (await page.context().cookies()).find((c) => c.name === 'csrf')?.value ?? '',
          },
          data: { feeSubmission: { guardianUploadLink: true } },
        });
      }

      // A billable child of our own: the demo tenant's invoices are all settled, and a settled
      // invoice cannot exercise the form at all.
      const { classId, className } = await seedClassSectionStudent(page);
      const head = await apiSetupPost<{ id: string }>(page, '/fee-heads', { name: `GL ${Date.now()}` });
      const years = await apiSetupGet<{ id: string; isCurrent: boolean }[]>(page, '/academic-years');
      const year = years.find((y) => y.isCurrent) ?? years[0];
      const campuses = await apiSetupGet<{ id: string; name: string }[]>(page, '/campuses');
      const campus = campuses.find((c) => c.name === 'E2E Automation') ?? campuses[0];
      await apiSetupPost(page, '/fee-structures', {
        campusId: campus.id, classId, feeHeadId: head.id,
        academicYearId: year.id, amount: 1500, frequency: 'MONTHLY',
      });

      const now = new Date();
      await apiSetupPost(page, '/fees/invoice-batches', {
        classId, month: now.getMonth() + 1, year: now.getFullYear(),
      });
      const invoices = await apiSetupGet<{ data: { id: string; status: string }[] }>(
        page, `/fees/invoices?pageSize=100&month=${now.getMonth() + 1}&year=${now.getFullYear()}`,
      );
      const invoice = invoices.data.find((i) => i.status !== 'PAID');
      expect(invoice, `no unpaid invoice generated for ${className}`).toBeTruthy();

      const { url } = await apiSetupPost<{ url: string }>(page, `/fees/invoices/${invoice!.id}/guardian-link`, {});

      // A SEPARATE context, not `clearCookies()` on this one: the guardian is on a different
      // phone, and wiping the office's session here also broke this spec's own cleanup.
      const guardianCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      const guardian = await guardianCtx.newPage();
      await guardian.goto(url);

      // The child is named, but only by first name — the link gets forwarded.
      await expect(guardian.getByRole('heading', { name: /^Fee for / })).toBeVisible();
      const body = await guardian.locator('body').innerText();
      expect(body).not.toContain('Student ');   // seeded full name is "Student <ts>"
      expect(body).not.toMatch(/GR\s*\d/);      // no GR number

      // No app shell — there is nothing here to sign in to.
      await expect(guardian.locator('.sidebar')).toHaveCount(0);

      // The sentence the whole claim/payment split rests on.
      await expect(guardian.getByText(/checks this against their bank records/i)).toBeVisible();

      await guardian.getByRole('button', { name: /Send to the school/ }).click();
      await expect(guardian.getByText(/we have your details/i)).toBeVisible();
      // It must never read as a receipt.
      await expect(guardian.getByText(/This is not a\s+receipt/i)).toBeVisible();
      await guardianCtx.close();
    } finally {
      if (!wasOn) {
        await page.request.patch('http://localhost:3001/api/v1/school-settings', {
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': (await page.context().cookies()).find((c) => c.name === 'csrf')?.value ?? '',
          },
          data: { feeSubmission: { guardianUploadLink: false } },
        });
      }
    }
  });
});
