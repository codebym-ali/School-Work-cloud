import { test, expect } from '@playwright/test';
import { signIn, world } from './qa-world';

/** FEE-01..06 — corrections on the student profile (Phase 2). Ali paid July in cash; Sara owes July. */
test.describe('FEE · corrections on the student profile', () => {
  test('FEE-01 + FEE-02 reversing needs a reason, then keeps the receipt marked reversed', async ({ browser }) => {
    const w = world();
    const { page, context } = await signIn(browser, 'owner');
    await page.goto(`/students?student=${w.students.paid.id}`);
    const fees = page.locator('.card', { has: page.getByRole('heading', { name: 'Fees', exact: true }) });
    await fees.getByRole('button', { name: 'Reverse', exact: true }).click();

    const confirm = page.getByRole('button', { name: 'Reverse payment' });
    await expect(confirm, 'FEE-01: disabled with no reason').toBeDisabled();
    await page.locator('#reasoned-action-reason').fill('QA FEE-02: posted against the wrong student');
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.getByText(/Reversed\. Reversal receipt .+ issued\./)).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();

    await expect(fees.getByText(/reversed · /)).toBeVisible();
    await expect(fees.getByRole('button', { name: 'Reverse', exact: true })).toHaveCount(0);
    await context.close();
  });

  test('FEE-03 waiving closes the invoice with a reason', async ({ browser }) => {
    const w = world();
    const { page, context } = await signIn(browser, 'owner');
    await page.goto(`/students?student=${w.students.owingWaive.id}`);
    const fees = page.locator('.card', { has: page.getByRole('heading', { name: 'Fees', exact: true }) });
    await fees.getByRole('button', { name: 'Waive', exact: true }).click();
    await page.locator('#reasoned-action-reason').fill('QA FEE-03: staff child concession');
    await page.getByRole('button', { name: 'Waive the balance' }).click();
    await expect(page.getByText('Waived. The invoice is closed.')).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(fees.getByText('WAIVED')).toBeVisible();
    await expect(fees.getByText('Nothing outstanding')).toBeVisible();
    await context.close();
  });

  test('FEE-04 an advance is recorded against the guardian', async ({ browser }) => {
    const w = world();
    const { page, context } = await signIn(browser, 'owner');
    await page.goto(`/students?student=${w.students.paid.id}`);
    await page.getByRole('button', { name: 'Record advance', exact: true }).first().click();
    await page.locator('#advance-amount').fill('1500');
    const responsePromise = page.waitForResponse((r) => r.url().includes('/fees/advances') && r.request().method() === 'POST');
    await page.getByRole('dialog').getByRole('button', { name: /Record/ }).last().click();
    expect((await responsePromise).status()).toBeLessThan(300);
    await context.close();
  });

  test('FEE-05 the accountant is offered no reverse or waive', async ({ browser }) => {
    const { page, context } = await signIn(browser, 'accountantA');
    await page.goto('/fees');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reverse', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Waive', exact: true })).toHaveCount(0);
    await context.close();
  });

  test('FEE-06 the campus admin sees fees on a profile but cannot correct them', async ({ browser }) => {
    const w = world();
    const { page, context } = await signIn(browser, 'campusAdmin');
    await page.goto(`/students?student=${w.students.owingWithdraw.id}`);
    const fees = page.locator('.card', { has: page.getByRole('heading', { name: 'Fees', exact: true }) });
    await expect(fees).toBeVisible();
    await expect(fees.getByRole('button', { name: 'Reverse', exact: true })).toHaveCount(0);
    await expect(fees.getByRole('button', { name: 'Waive', exact: true })).toHaveCount(0);
    await context.close();
  });
});
