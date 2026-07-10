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
test.describe('fees', () => {
  test('generate invoice batch, then partial + full payment → PAID', async ({ page }) => {
    await gotoApp(page);
    const { className, studentName } = await seedClassSectionStudent(page);

    // Resolve ids for the fee-structure setup (UI has no fee-setup screen).
    const [campuses, years, classes] = await Promise.all([
      apiSetupGet<Campus[]>(page, '/campuses'),
      apiSetupGet<AcademicYear[]>(page, '/academic-years'),
      apiSetupGet<Klass[]>(page, '/classes'),
    ]);
    const campusId = campuses[0].id;
    const academicYearId = (years.find((y) => y.isCurrent) ?? years[0]).id;
    const classId = classes.find((c) => c.name === className)!.id;

    // Fee head + MONTHLY structure of Rs 5000 for the fresh class.
    const head = await apiSetupPost<{ id: string }>(page, '/fee-heads', { name: `Tuition ${Date.now()}` });
    await apiSetupPost(page, '/fee-structures', {
      campusId, classId, feeHeadId: head.id, academicYearId, amount: 5000, frequency: 'MONTHLY',
    });

    const now = new Date();
    const month = String(now.getUTCMonth() + 1);
    const year = String(now.getUTCFullYear());

    // Generate the invoice batch on the Fees screen.
    await page.getByRole('link', { name: 'Fees', exact: true }).click();
    await page.waitForURL('**/fees');
    const genCard = page.locator('.card', { hasText: 'Generate invoices' });
    await genCard.locator('label:text-is("Class") + select').selectOption({ label: className });
    await genCard.locator('label:text-is("Month") + input').fill(month);
    await genCard.locator('label:text-is("Year") + input').fill(year);
    await genCard.getByRole('button', { name: 'Generate' }).click();
    await expect(page.locator('.toast.ok')).toContainText('Generated 1 invoice(s)');

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
