import { test, expect } from '@playwright/test';
import { navLabels, signIn } from './qa-world';

/** NAV-01..04 — each role's menu offers exactly the screens its API allows (Owner Gaps QA Test Plan). */
test.describe('NAV · menus by role', () => {
  test('NAV-01 owner sees the owner-gap screens', async ({ browser }) => {
    const { page, context } = await signIn(browser, 'owner');
    const nav = await navLabels(page);
    for (const label of ['Payroll', 'Activity log', 'Defaulters', 'Year-end promotion', 'Campus Hub', 'SMS & notifications', 'Staff', 'Students', 'Fees']) {
      expect(nav, `owner menu has ${label}`).toContain(label);
    }
    await context.close();
  });

  test('NAV-02 accountant sees money and payroll, not people or promotion', async ({ browser }) => {
    const { page, context } = await signIn(browser, 'accountantA');
    const nav = await navLabels(page);
    for (const label of ['Payroll', 'Fees', 'Defaulters']) expect(nav, `accountant menu has ${label}`).toContain(label);
    for (const label of ['Students', 'Staff', 'Activity log', 'Year-end promotion', 'Campus Hub']) expect(nav, `accountant menu lacks ${label}`).not.toContain(label);
    await context.close();
  });

  test('NAV-03 teacher sees My Payslips and no payroll or fees', async ({ browser }) => {
    const { page, context } = await signIn(browser, 'teacher');
    const nav = await navLabels(page);
    for (const label of ['Payroll', 'Fees', 'Defaulters']) expect(nav, `teacher menu lacks ${label}`).not.toContain(label);
    // A teacher's shell is a tab bar; the personal pages live under More.
    await page.goto('/me-more');
    await expect(page.getByRole('link', { name: 'My Payslips' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Payroll', exact: true })).toHaveCount(0);
    await context.close();
  });

  test('NAV-04 campus admin sees campus tools, not payroll or Campus Hub', async ({ browser }) => {
    const { page, context } = await signIn(browser, 'campusAdmin');
    const nav = await navLabels(page);
    for (const label of ['Activity log', 'Year-end promotion', 'SMS & notifications', 'Staff', 'Students']) expect(nav, `campus admin menu has ${label}`).toContain(label);
    for (const label of ['Payroll', 'Campus Hub']) expect(nav, `campus admin menu lacks ${label}`).not.toContain(label);
    await context.close();
  });
});
