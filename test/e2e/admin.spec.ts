import { test, expect } from '@playwright/test';
import { gotoAdmin, cardByHeading, fieldInput, PLATFORM_STORAGE_STATE } from './helpers';

/**
 * Vendor console (blueprint §24): the platform admin provisions a throwaway tenant,
 * sees it listed, suspends it, and reactivates it. Uses the platform-admin session
 * (not the tenant-owner one). Never touches `demo` — other specs log into it.
 */
test.describe('admin (vendor console)', () => {
  test.use({ storageState: PLATFORM_STORAGE_STATE });

  test('provision → list → suspend → reactivate a throwaway tenant', async ({ page }) => {
    await gotoAdmin(page);

    const ts = Date.now();
    const subdomain = `admin-${ts}`;

    // Provision a new tenant.
    await page.getByRole('button', { name: '+ New tenant' }).click();
    const form = cardByHeading(page, 'New tenant');
    await fieldInput(form, 'School name').fill(`Admin Test ${ts}`);
    await fieldInput(form, 'Subdomain').fill(subdomain);
    await fieldInput(form, 'Owner email').fill(`owner-${subdomain}@example.com`);
    // ⚠️ There is no 'Owner password' field any more, deliberately: provisioning takes only
    // name + subdomain + owner email and the owner sets their own via the set-password link.
    // A console that types a password on the operator's behalf is the thing that was removed.

    const provReq = page.waitForRequest((r) => r.url().endsWith('/platform/tenants') && r.method() === 'POST');
    await form.getByRole('button', { name: 'Provision tenant' }).click();
    expect((await (await provReq).postDataJSON()).subdomain).toBe(subdomain);
    await expect(page.locator('.toast.ok')).toContainText(`Provisioned ${subdomain}`);

    // It appears in the list, active.
    const row = page.locator('tbody tr', { hasText: subdomain });
    await expect(row).toBeVisible();
    await expect(row.locator('.badge')).toContainText('active');

    // Suspend it (assert the POST + the badge flip). Never suspend `demo`.
    expect(subdomain).not.toBe('demo');
    const suspendReq = page.waitForRequest((r) => /\/platform\/tenants\/.+\/suspend$/.test(r.url()) && r.method() === 'POST');
    await row.getByRole('button', { name: 'Suspend' }).click();
    // ⚠️ **Suspending demands a stated REASON (SA0) — the row button opens a form, it does not
    // act.** Locking a school out of the product is not a one-click side effect, and the reason is
    // recorded against the tenant. This spec used to click the row button and wait for the POST,
    // which therefore never came: the test was asserting a bare-button flow the product removed.
    await page.locator('#suspend-reason').fill('e2e automated check');
    await page.getByRole('button', { name: 'Suspend tenant' }).click();
    await suspendReq;
    const rowSuspended = page.locator('tbody tr', { hasText: subdomain });
    await expect(rowSuspended.locator('.badge')).toContainText('suspended');
    await expect(page.locator('.toast.ok')).toContainText(`Suspended ${subdomain}`);

    // Reactivate it.
    const reactivateReq = page.waitForRequest((r) => /\/platform\/tenants\/.+\/reactivate$/.test(r.url()) && r.method() === 'POST');
    await rowSuspended.getByRole('button', { name: 'Reactivate' }).click();
    await reactivateReq;
    await expect(page.locator('tbody tr', { hasText: subdomain }).locator('.badge')).toContainText('active');
    await expect(page.locator('.toast.ok')).toContainText(`Reactivated ${subdomain}`);
  });
});
