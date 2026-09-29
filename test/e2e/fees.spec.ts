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

    // ⚠️ **A month can only be billed once per (class, month, year), and financial records are NEVER
    // deleted** — the teardown deliberately preserves payment-bearing students ("a real record
    // rather than debris", see global-teardown), so this reused class's batches accumulate for ever.
    //
    // The old fix walked forward from `now` up to 24 months. That re-walked the whole billed backlog
    // on every run AND ran off the end once ~two years of months were spent — which is exactly how
    // this spec started failing with "no unbilled month found in the next two years" on the shared
    // demo tenant. The tenant issue is fixture accumulation, and the only clean answer that does not
    // delete financial records is to **jump past the frontier**: read the latest month ANY class has
    // billed and take the next slot. One read, one generate, and it can never exhaust.
    //
    // ⚠️ The frontier is the highest BILLED month, but the invoices endpoint sorts by `createdAt`,
    // not by month — and a prior run's far-future invoice has an OLD createdAt, so it is NOT on the
    // first page. Reading one page would under-estimate the frontier and the march below could run
    // off the end again. So page THROUGH every invoice and take the true max: bounded by the invoice
    // count, a handful of reads, and correct regardless of ordering.
    const monthKey = (year: number, month: number) => year * 12 + (month - 1);
    let frontier = monthKey(now.getUTCFullYear(), now.getUTCMonth() + 1);
    for (let pageNo = 1; ; pageNo += 1) {
      const res = await apiSetupGet<{ data: { month: number | null; year: number }[]; total: number; pageSize: number }>(
        page, `/fees/invoices?pageSize=100&page=${pageNo}`);
      for (const inv of res.data) frontier = Math.max(frontier, monthKey(inv.year, inv.month ?? 1));
      if (res.data.length < 100 || pageNo * 100 >= res.total) break;
    }

    let billed = false;
    for (let i = 1; i <= 24 && !billed; i += 1) {
      const key = frontier + i;
      const y = Math.floor(key / 12);
      const mo = (key % 12) + 1;
      await genCard.locator('label:text-is("Month") + input').fill(String(mo));
      await genCard.locator('label:text-is("Year") + input').fill(String(y));
      // ⚠️ Read the RESPONSE, not the toast — a toast from the previous iteration lingers, so a
      // just-billed month can still look unbilled and the loop over-bills. (It billed three months
      // in one run before this was caught.)
      const posted = page.waitForResponse(
        (r) => r.url().includes('/fees/invoice-batches') && r.request().method() === 'POST');
      await genCard.getByRole('button', { name: 'Generate' }).click();
      const body = (await (await posted).json()) as { generated?: number };
      billed = body.generated === 1;
    }
    expect(billed, 'no unbilled month past the billing frontier — the reused fee class may be saturated').toBe(true);

    // Invoice row for our student: total Rs 5,000, status PENDING.
    const row = page.locator('tbody tr', { hasText: studentName });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Rs 5,000');
    await expect(row.locator('.badge')).toContainText('Pending');

    // Partial payment of Rs 2,000 → PARTIAL.
    await row.getByRole('button', { name: 'Collect' }).click();
    await row.locator('input[placeholder="Amount"]').fill('2000');
    const payReq1 = page.waitForRequest((r) => /\/fees\/invoices\/.+\/payments/.test(r.url()) && r.method() === 'POST');
    await row.getByRole('button', { name: 'Save' }).click();
    expect((await (await payReq1).postDataJSON()).amountPaid).toBe(2000);
    await expect(page.locator('.toast.ok')).toContainText('Payment recorded');
    const rowAfterPartial = page.locator('tbody tr', { hasText: studentName });
    await expect(rowAfterPartial.locator('.badge')).toContainText('Partial');
    await expect(rowAfterPartial).toContainText('Rs 2,000'); // paid column

    // Collect the remainder (Collect prefills the outstanding 3,000) → PAID.
    await rowAfterPartial.getByRole('button', { name: 'Collect' }).click();
    const payReq2 = page.waitForRequest((r) => /\/fees\/invoices\/.+\/payments/.test(r.url()) && r.method() === 'POST');
    await rowAfterPartial.getByRole('button', { name: 'Save' }).click();
    expect((await (await payReq2).postDataJSON()).amountPaid).toBe(3000);
    await expect(page.locator('.toast.ok')).toContainText('Payment recorded');
    await expect(page.locator('tbody tr', { hasText: studentName }).locator('.badge')).toContainText('Paid');
  });
});
