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
      const { classId, className, studentName } = await seedClassSectionStudent(page, { name: 'E2E Guardian' });
      // Found before created, and the structure below with it. ⚠️ `GL <timestamp>` per run left
      // **30 dead fee heads** in the operator's dropdown — the same leak fees.spec had. Nothing
      // deletes a fee head here, so the name has to be one that can be reused.
      const heads = await apiSetupGet<{ id: string; name: string }[]>(page, '/fee-heads');
      const head = heads.find((h) => h.name === 'E2E Guardian Fee')
        ?? await apiSetupPost<{ id: string }>(page, '/fee-heads', { name: 'E2E Guardian Fee' });
      const years = await apiSetupGet<{ id: string; isCurrent: boolean }[]>(page, '/academic-years');
      const year = years.find((y) => y.isCurrent) ?? years[0];
      const campuses = await apiSetupGet<{ id: string; name: string }[]>(page, '/campuses');
      const campus = campuses.find((c) => c.name === 'E2E Automation') ?? campuses[0];
      const structures = await apiSetupGet<{ id: string }[]>(page, `/fee-structures?classId=${classId}`);
      if (structures.length === 0) {
        await apiSetupPost(page, '/fee-structures', {
          campusId: campus.id, classId, feeHeadId: head.id,
          academicYearId: year.id, amount: 1500, frequency: 'MONTHLY',
        });
      }

      // ⚠️ **Bill a month this class has not billed before.** `createBatch` returns early when a
      // batch for (class, month, year) already exists and generates nothing, and there is no DELETE
      // for a financial record — so with a reused class, re-billing the current month leaves this
      // run's child with no invoice at all. It only worked while every run got a brand-new class.
      const now = new Date();
      let billed: { month: number; year: number } | undefined;
      for (let i = 0; i < 24 && !billed; i += 1) {
        const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
        const month = at.getUTCMonth() + 1;
        const year = at.getUTCFullYear();
        const res = await apiSetupPost<{ generated?: number }>(
          page, '/fees/invoice-batches', { classId, month, year });
        if (res.generated === 1) billed = { month, year };
      }
      expect(billed, `no unbilled month found for ${className}`).toBeTruthy();

      // ⚠️ **This child's invoice, not merely an unpaid one.** The original picked the first
      // non-PAID invoice in the whole month across the tenant, so it could mint a guardian link for
      // somebody else's child entirely — and the assertions about hiding a full name would then be
      // checking a student this test never created.
      const invoices = await apiSetupGet<{ data: { id: string; status: string;
        student: { fullName: string | null } }[] }>(
        page, `/fees/invoices?pageSize=100&month=${billed!.month}&year=${billed!.year}`,
      );
      const invoice = invoices.data.find((i) => i.student.fullName === studentName && i.status !== 'PAID');
      expect(invoice, `no unpaid invoice generated for ${studentName} in ${className}`).toBeTruthy();

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

      // Take it back out of the queue. The submission this spec makes is real, and "Payment
      // submissions" is a screen the office actually works — three runs left three PENDING rows
      // for someone to puzzle over. Rejecting is the supported undo (a claim is never deleted:
      // the record of what was submitted is the point), and a REJECTED row sits in a tab nobody
      // is asked to action.
      // Matched on the student, not the invoice: the claims list does not project `invoice.id`,
      // so filtering on it silently matched nothing and the cleanup ran over an empty array.
      const pending = await apiSetupGet<{ data: { id: string; student: { fullName: string } }[] }>(page, '/fees/claims?status=PENDING');
      const mine = pending.data.filter((c) => c.student.fullName === studentName);
      for (const c of mine) {
        await apiSetupPost(page, `/fees/claims/${c.id}/reject`, { reason: 'Automated test submission' });
      }
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
