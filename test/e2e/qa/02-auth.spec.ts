import { test, expect } from '@playwright/test';
import { STORAGE_STATE } from '../helpers';
import { routeToTenant, signIn, world } from './qa-world';

/**
 * AUTH-01..04 — doors and two-factor (Phase 0).
 *
 * AUTH-02/03 need an owner who has NOT enrolled two-factor. The QA owner is enrolled, so those two cases use the demo
 * school's owner session (already unenrolled, shared by the main suite) and only READ or attempt a refused action —
 * they change nothing there.
 */
test.describe('AUTH · doors and two-factor', () => {
  test('AUTH-01 the Campus Hub login link opens the staff door, where a campus admin signs in', async ({ browser }) => {
    const { page, context } = await signIn(browser, 'owner');
    await page.goto('/campuses');
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: /Campus login/ }).first().click();
    const popup = await popupPromise;
    const link = new URL(popup.url());
    await popup.close();
    expect(link.port, 'staff door').toBe('3006');
    expect(link.pathname).toBe('/login');
    expect(link.searchParams.get('campus')).toBeTruthy();
    await context.close();

    // The person it is meant for can use it.
    const admin = await signIn(browser, 'campusAdmin');
    expect(new URL(admin.page.url()).port).toBe('3006');
    await admin.context.close();
  });

  test('AUTH-02 an owner without two-factor is told exactly what is locked', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: 'http://localhost:3005', storageState: STORAGE_STATE });
    const page = await context.newPage();
    await page.goto('/dashboard');
    const banner = page.locator('.toast.err', { hasText: 'Set up two-factor authentication' });
    await expect(banner).toBeVisible();
    for (const word of ['reverse payments', 'waive fees', 'CNIC', 'approve payroll', 'staff access']) await expect(banner).toContainText(word);
    await expect(banner.getByRole('link')).toHaveAttribute('href', '/security');
    await context.close();
  });

  test('AUTH-03 a gated action without two-factor is refused and changes nothing', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: 'http://localhost:3005', storageState: STORAGE_STATE });
    const page = await context.newPage();
    await page.goto('/dashboard');
    const paid = await page.evaluate(async () => (await (await fetch('/api/v1/fees/invoices?status=PAID&pageSize=20', { credentials: 'include' })).json()).data as Array<{ studentId: string }>);
    test.skip(paid.length === 0, 'demo school has no paid invoice to attempt a reversal on');
    await page.goto(`/students?student=${paid[0].studentId}`);
    const reverse = page.getByRole('button', { name: 'Reverse', exact: true }).first();
    await expect(reverse).toBeVisible();
    await reverse.click();
    await page.locator('#reasoned-action-reason').fill('QA AUTH-03: should be refused without two-factor');
    await page.getByRole('button', { name: 'Reverse payment' }).click();
    await expect(page.getByText('This needs two-factor authentication on your account. Nothing was changed.')).toBeVisible();
    await context.close();
  });

  test('AUTH-04 the owner door refuses a campus admin; the staff door admits them', async ({ browser }) => {
    const w = world();
    const context = await browser.newContext({ baseURL: `http://${w.subdomain}.localhost:3005`, storageState: { cookies: [], origins: [] } });
    await routeToTenant(context, w);
    const page = await context.newPage();
    await page.goto('/login');
    await page.getByLabel('Email').fill(w.accounts.campusAdmin.email);
    await page.getByLabel('Password', { exact: true }).fill(w.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.locator('.sidebar')).toHaveCount(0);
    // Asserted by the refusal's words: an empty Next.js route announcer also carries role=alert.
    await expect(page.getByText(/invalid email or password/i)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/login');
    await context.close();

    const staff = await signIn(browser, 'campusAdmin');
    await expect(staff.page.locator('.sidebar')).toBeVisible();
    await staff.context.close();
  });
});
