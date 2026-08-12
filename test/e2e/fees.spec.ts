import { test, expect } from '@playwright/test';
import { gotoApp, seedClassSectionStudent, apiSetupGet, apiSetupPost } from './helpers';

interface Campus { id: string; name: string }
interface AcademicYear { id: string; isCurrent: boolean }
interface Klass { id: string; name: string }

/**
 * Drives the Fees screen: generate a monthly invoice batch for a fresh class (whose
 * fee structure is created via the API, since the UI doesn't expose fee setup), then
 * collect a partial payment (→ PARTIAL) and the remainder (→ PAID). Asserts the posted
 * payment amount at the network layer and the status transitions in the table.
 */
const E2E_FEE_HEAD = 'E2E Tuition';

test.describe('fees', () => {
  test('generate invoice batch, then partial + full payment → PAID', async ({ page }) => {
    await gotoApp(page);
    const { className, studentName } = await seedClassSectionStudent(page, { name: 'E2E Fees' });

    // Resolve ids for the fee-structure setup (UI has no fee-setup screen).
    const [campuses, years, classes] = await Promise.all([
      apiSetupGet<Campus[]>(page, '/campuses'),
      apiSetupGet<AcademicYear[]>(page, '/academic-years'),
      apiSetupGet<Klass[]>(page, '/classes'),
    ]);
    const campusId = campuses[0].id;
    const academicYearId = (years.find((y) => y.isCurrent) ?? years[0]).id;
    const classId = classes.find((c) => c.name === className)!.id;

    // Fee head + MONTHLY structure of Rs 5000 — **found before created, both of them.**
    //
    // ⚠️ This spec used to mint `Tuition <timestamp>` every run and delete nothing, and the demo
    // tenant reached **33 of them out of 64 fee heads**: the operator's fee dropdown was half test
    // debris. fee-plan.spec had already written the warning about exactly this and removes its own
    // heads; this spec had the same leak and no cleanup. A second structure also meant a second
    // line item, which is why the invoice read Rs 10,000 on the second run.
    const heads = await apiSetupGet<{ id: string; name: string }[]>(page, '/fee-heads');
    const head = heads.find((h) => h.name === E2E_FEE_HEAD)
      ?? await apiSetupPost<{ id: string }>(page, '/fee-heads', { name: E2E_FEE_HEAD });
    const structures = await apiSetupGet<{ id: string }[]>(page, `/fee-structures?classId=${classId}`);
    if (structures.length === 0) {
      await apiSetupPost(page, '/fee-structures', {
        campusId, classId, feeHeadId: head.id, academicYearId, amount: 5000, frequency: 'MONTHLY',
      });
    }

    const now = new Date();

    // Generate the invoice batch on the Fees screen.
    await page.getByRole('link', { name: 'Fees', exact: true }).click();
    await page.waitForURL('**/fees');
    const genCard = page.locator('.card', { hasText: 'Generate invoices' });
    await genCard.locator('label:text-is("Class") + select').selectOption({ label: className });

    // ⚠️ **A month can only be billed once, ever.** `createBatch` returns early when a batch for
    // (class, month, year) exists and generates nothing — and there is no DELETE for an invoice or
    // a batch, deliberately: a financial record is not test debris to be swept away. So a reused
    // class cannot re-bill the month a previous run already billed. Walk forward to the first month
    // this class has never billed, instead of asserting against a slot that is already spent.
    // (Before the fixture was reused this never came up: every run invoiced a brand-new class.)
    let billed = false;
    for (let i = 0; i < 24 && !billed; i += 1) {
      const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      await genCard.locator('label:text-is("Month") + input').fill(String(at.getUTCMonth() + 1));
      await genCard.locator('label:text-is("Year") + input').fill(String(at.getUTCFullYear()));
      // ⚠️ Read the RESPONSE, not the toast. Reading `.toast.ok` matched the toast still on screen
      // from the previous iteration, so a month that had just been billed still looked unbilled and
      // the loop kept going — it billed three months in one run before this was caught.
      const posted = page.waitForResponse(
        (r) => r.url().includes('/fees/invoice-batches') && r.request().method() === 'POST');
      await genCard.getByRole('button', { name: 'Generate' }).click();
      const body = (await (await posted).json()) as { generated?: number };
      billed = body.generated === 1;
    }
    expect(billed, 'no unbilled month found in the next two years').toBe(true);

    // Invoice row for our student: total Rs 5,000, status PENDING.
    const row = page.locator('tbody tr', { hasText: studentName });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Rs 5,000');
    await expect(row.locator('.badge')).toContainText('PENDING');

    // Partial payment of Rs 2,000 → PARTIAL.
    await row.getByRole('button', { name: 'Collect' }).click();
    await row.locator('input[placeholder="Amount"]').fill('2000');
    const payReq1 = page.waitForRequest((r) => /\/fees\/invoices\/.+\/payments/.test(r.url()) && r.method() === 'POST');
    await row.getByRole('button', { name: 'Save' }).click();
    expect((await (await payReq1).postDataJSON()).amountPaid).toBe(2000);
    await expect(page.locator('.toast.ok')).toContainText('Payment recorded');
    const rowAfterPartial = page.locator('tbody tr', { hasText: studentName });
    await expect(rowAfterPartial.locator('.badge')).toContainText('PARTIAL');
    await expect(rowAfterPartial).toContainText('Rs 2,000'); // paid column

    // Collect the remainder (Collect prefills the outstanding 3,000) → PAID.
    await rowAfterPartial.getByRole('button', { name: 'Collect' }).click();
    const payReq2 = page.waitForRequest((r) => /\/fees\/invoices\/.+\/payments/.test(r.url()) && r.method() === 'POST');
    await rowAfterPartial.getByRole('button', { name: 'Save' }).click();
    expect((await (await payReq2).postDataJSON()).amountPaid).toBe(3000);
    await expect(page.locator('.toast.ok')).toContainText('Payment recorded');
    await expect(page.locator('tbody tr', { hasText: studentName }).locator('.badge')).toContainText('PAID');
  });
});
