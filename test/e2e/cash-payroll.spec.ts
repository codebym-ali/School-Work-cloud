import { test, expect } from '@playwright/test';

/**
 * Cash Payroll Plan (WS4.2) — what the accountant and a teacher actually see on the staff door.
 *
 * The integration suite proves the rules; this proves the screens do not offer what the rules refuse: Payroll is
 * reachable by the accountant, Approve never renders for them, and a teacher's My Payslips names each month and
 * never shows a draft. One form login per role (the §29 limiter).
 */
const STAFF = 'http://localhost:3006';

test.describe('cash payroll — staff door', () => {
  test.use({ baseURL: STAFF, storageState: { cookies: [], origins: [] } });

  async function signIn(page: import('@playwright/test').Page, email: string, password: string) {
    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.locator('.sidebar')).toBeVisible();
  }

  test('the accountant reaches Payroll for their campus and is never offered Approve', async ({ page }) => {
    const errors: string[] = [];
    page.on('response', (r) => { if (r.url().includes('/api/v1/') && r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
    await signIn(page, 'accountant@demo.pk', 'Money!Secret12');

    await page.locator('.sidebar').getByRole('link', { name: 'Payroll', exact: true }).click();
    await page.waitForURL('**/payroll');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Payroll');
    await expect(page.getByRole('button', { name: 'Draft payroll' })).toBeVisible();
    // A campus-bound accountant drafts their own campus: no campus picker.
    await expect(page.locator('#pr-campus')).toHaveCount(0);
    await expect(page.getByText('Payroll history')).toBeVisible();

    // Open the newest run if there is one, and check the role-specific controls.
    const openBtn = page.getByRole('button', { name: 'Open', exact: true }).first();
    if (await openBtn.count()) {
      await openBtn.click();
      await expect(page.getByText('Total net pay')).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("a teacher's payslips are named by month and never drafts", async ({ page }) => {
    await signIn(page, 'teacher@demo.pk', 'Teach!Secret12');
    await page.goto('/my-payslips');
    await expect(page.getByRole('heading', { name: 'My Payslips' })).toBeVisible();
    const rows = page.locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    const text = await page.locator('tbody').innerText();
    if (!/No payslips have been issued yet/.test(text)) {
      await expect(rows.first().locator('td').first()).toHaveText(/^(January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/);
      await expect(page.locator('tbody')).not.toContainText(/draft/i);
    }
  });
});
