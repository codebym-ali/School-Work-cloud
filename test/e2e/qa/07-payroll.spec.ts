import { test, expect, type Page } from '@playwright/test';
import { signIn, world } from './qa-world';

/**
 * PAY-01..13 — cash payroll (Phase 5 + Cash Payroll Plan), run end to end as the people who do it.
 *
 * Month under test: July 2026. Campus A payroll holds Asma (accountant A, Rs 30,000) and Tariq (teacher, Rs 40,000).
 * Camila (campus admin) is given a salary in PAY-01; the admission officer has none, so is named as left out.
 */
async function openJuly(page: Page) {
  await page.goto('/payroll');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Payroll');
  const row = page.locator('tbody tr', { hasText: 'July 2026' }).first();
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: /July 2026/, level: 2 })).toBeVisible();
}
const staffRow = (page: Page, name: string) => page.locator('tbody tr', { hasText: name }).first();

test.describe.serial('PAY · cash payroll', () => {
  test('PAY-01 a salary is one monthly amount and a date', async ({ browser }) => {
    const { page, context } = await signIn(browser, 'owner');
    await page.goto('/staff');
    const row = page.locator('div.stack', { has: page.locator('strong', { hasText: /^Camila Admin$/ }) }).last();
    await row.getByRole('button', { name: '💰 Salary' }).click();
    await expect(row.getByText('No salary set. This person is left out of payroll until one is.')).toBeVisible();
    await row.getByRole('button', { name: 'Set salary' }).click();
    // Only two fields: no allowances, no fixed deductions.
    await expect(row.getByLabel('Monthly salary (Rs)')).toBeVisible();
    await expect(row.getByLabel('From')).toBeVisible();
    await expect(row.getByText(/allowance/i)).toHaveCount(0);
    await row.getByLabel('Monthly salary (Rs)').fill('45000');
    await row.getByLabel('From').fill('2026-01-01');
    await row.getByRole('button', { name: 'Save salary' }).click();
    await expect(row.getByText('current')).toBeVisible();
    await expect(row).toContainText('Rs 45,000');
    await context.close();
  });

  test('PAY-02 the accountant drafts their own campus, and is not offered Approve; PAY-03 staff without salary are named', async ({ browser }) => {
    const w = world();
    const { page, context } = await signIn(browser, 'accountantA');
    await page.goto('/payroll');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(w.campusA.name);
    await expect(page.locator('#pr-campus'), 'no campus picker').toHaveCount(0);
    await page.locator('#pr-month').selectOption('7');
    await page.locator('#pr-year').fill('2026');
    await page.getByRole('button', { name: 'Draft payroll' }).click();

    await expect(page.getByRole('heading', { name: /July 2026/, level: 2 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await expect(page.getByText('Draft — waiting for the owner to approve.')).toBeVisible();
    for (const name of ['Tariq Teacher', 'Asma Accountant', 'Camila Admin']) await expect(staffRow(page, name)).toBeVisible();
    await expect(staffRow(page, 'Tariq Teacher')).toContainText('After approval');
    await expect(page.locator('.toast.warn', { hasText: 'Not in this payroll (no salary set)' }), 'PAY-03').toContainText('admissions.a@qa.pk');
    await context.close();
  });

  test('PAY-04 staff never see a draft payslip', async ({ browser }) => {
    const { page, context } = await signIn(browser, 'teacher');
    await page.goto('/my-payslips');
    await expect(page.getByText('No payslips have been issued yet.')).toBeVisible();
    await context.close();
  });

  test('PAY-05 the accountant can discard a draft and draft again', async ({ browser }) => {
    const { page, context } = await signIn(browser, 'accountantA');
    await openJuly(page);
    await page.getByRole('button', { name: 'Discard draft' }).click();
    await expect(page.getByText('Draft discarded.')).toBeVisible();
    await expect(page.locator('tbody tr', { hasText: 'July 2026' })).toHaveCount(0);
    await page.locator('#pr-month').selectOption('7');
    await page.locator('#pr-year').fill('2026');
    await page.getByRole('button', { name: 'Draft payroll' }).click();
    await expect(page.getByRole('heading', { name: /July 2026/, level: 2 })).toBeVisible();
    await context.close();
  });

  test('PAY-06 the owner approves, told plainly that it is final', async ({ browser }) => {
    const { page, context } = await signIn(browser, 'owner');
    await openJuly(page);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Approving is final');
    await expect(dialog).toContainText('each person can see their payslip');
    await page.locator('#reasoned-action-reason').fill('QA PAY-06: checked against the register');
    await page.getByRole('button', { name: 'Approve payroll' }).click();
    await expect(page.getByText('Approved. The accountant can now record salaries as paid.')).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('.badge', { hasText: /^Approved$/ }).first()).toBeVisible();
    await context.close();
  });

  test('PAY-11a the teacher now sees July, approved but not yet paid', async ({ browser }) => {
    const { page, context } = await signIn(browser, 'teacher');
    await page.goto('/my-payslips');
    const row = page.locator('tbody tr', { hasText: 'July 2026' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Approved · not paid yet');
    await expect(row).toContainText('Rs 40,000');
    await context.close();
  });

  test('PAY-07 the accountant is reminded of salaries to pay', async ({ browser }) => {
    const { page, context } = await signIn(browser, 'accountantA');
    await page.goto('/dashboard');
    // Tariq and Camila are theirs to pay; their own salary is not counted.
    await expect(page.getByRole('link', { name: /2 approved salaries not yet paid/ })).toBeVisible();
    await context.close();
  });

  test('PAY-08 recording a cash payment; PAY-09 nobody records their own', async ({ browser }) => {
    const { page, context } = await signIn(browser, 'accountantA');
    await openJuly(page);
    await expect(page.getByText(/still to hand over/)).toBeVisible();

    const own = staffRow(page, 'Asma Accountant');
    await expect(own.getByRole('button', { name: 'Mark paid' }), 'PAY-09').toHaveCount(0);
    await expect(own).toContainText('Someone else records yours');

    const teacher = staffRow(page, 'Tariq Teacher');
    await teacher.getByRole('button', { name: 'Mark paid' }).click();
    const dialog = page.getByRole('dialog', { name: 'Record salary payment' });
    await expect(dialog.locator('#mp-method')).toHaveValue('CASH');
    await expect(dialog).toContainText('Rs 40,000');
    await dialog.locator('#mp-ref').fill('Handed over at the office');
    await dialog.getByRole('button', { name: 'Record cash payment' }).click();
    await expect(page.getByText("Tariq Teacher's salary recorded as paid.")).toBeVisible();
    await expect(teacher).toContainText('Cash');
    await expect(teacher).toContainText('by you');
    await context.close();
  });

  test("PAY-10 the owner records the accountant's own salary", async ({ browser }) => {
    const { page, context } = await signIn(browser, 'owner');
    await openJuly(page);
    const row = staffRow(page, 'Asma Accountant');
    await row.getByRole('button', { name: 'Mark paid' }).click();
    await page.getByRole('dialog', { name: 'Record salary payment' }).getByRole('button', { name: 'Record cash payment' }).click();
    await expect(row).toContainText('by you');
    await context.close();
  });

  test('PAY-11b the teacher sees July as paid', async ({ browser }) => {
    const { page, context } = await signIn(browser, 'teacher');
    await page.goto('/my-payslips');
    await expect(page.locator('tbody tr', { hasText: 'July 2026' })).toContainText(/Paid \d/);
    await context.close();
  });
});

test.describe('PAY · separation', () => {
  test("PAY-12 the other campus's accountant never sees campus A's payroll", async ({ browser }) => {
    const w = world();
    const { page, context } = await signIn(browser, 'accountantB');
    await page.goto('/payroll');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(w.campusB.name);
    await expect(page.getByText('Payroll history')).toBeVisible();
    await expect(page.getByText('Loading…')).toHaveCount(0);
    await expect(page.locator('tbody tr', { hasText: 'July 2026' })).toHaveCount(0);
    await context.close();
  });

  test('PAY-13 an accountant can open their own payslips (defect QA-D1 if this fails)', async ({ browser }) => {
    const { page, context } = await signIn(browser, 'accountantA');
    await page.goto('/my-payslips');
    await expect(page.getByRole('heading', { name: 'My Payslips' }), 'QA-D1: My Payslips unreachable for an accountant').toBeVisible();
    await context.close();
  });
});
