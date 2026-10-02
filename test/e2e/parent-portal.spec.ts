import { test, expect } from '@playwright/test';

/**
 * Parent portal (§28) against the live stack: a student signs in, lands on their
 * own portal (/me), sees only their read-only screens (not the admin nav), and can open fees.
 *
 * ⚠️ It used to post `student@demo.pk` / a password to the **staff** login form. No student can
 * sign in that way: students authenticate at `/student-login` with **registration number +
 * CNIC**, and every auto-provisioned student user has a deliberately NULL `password_hash`
 * (`students.service` creates the login only when a CNIC is supplied). So the spec was testing a
 * flow the product does not have, against an account a seed script could no longer create — it
 * needed an *unlinked* student, and every student on a real tenant is already linked.
 *
 * The credentials come from the environment because a CNIC is a real identity number: it must
 * not be committed, and this suite runs against the operator's own tenant.
 *
 *     E2E_STUDENT_REG_NO=... E2E_STUDENT_CNIC=... pnpm test:e2e
 *
 * Without them the spec skips rather than fails: an unconfigured environment is not a defect,
 * and a suite carrying a permanent red stops being usable as a gate.
 */
const regNo = process.env.E2E_STUDENT_REG_NO;
const cnic = process.env.E2E_STUDENT_CNIC;

test.describe('parent portal', () => {
  // Since the split the portal is its own app (parent-web:3003), serving the student door at
  // `/login` and the portal at root (`/me`, `/me/fees`). Run the whole spec on that origin.
  test.use({ baseURL: 'http://localhost:3003', storageState: { cookies: [], origins: [] } });

  test('student logs in with registration number + CNIC and sees their own read-only portal', async ({ page }) => {
    test.skip(!regNo || !cnic, 'Set E2E_STUDENT_REG_NO and E2E_STUDENT_CNIC to a student on the tenant under test.');

    await page.goto('/login');
    await page.getByLabel('Registration number').fill(regNo!);
    await page.getByLabel('CNIC / B-Form').fill(cnic!);
    await page.getByRole('button', { name: /sign in/i }).click();

    await page.waitForURL('**/me');
    await expect(page.getByRole('heading', { name: /welcome/i })).toBeVisible();

    const sidebar = page.locator('.sidebar');
    await expect(sidebar.getByRole('link', { name: 'My Dashboard' })).toBeVisible();
    await expect(sidebar.getByRole('link', { name: 'My Results' })).toBeVisible();
    // Admin screens are NOT offered to a student.
    await expect(sidebar.getByRole('link', { name: 'School configuration', exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole('link', { name: 'Students', exact: true })).toHaveCount(0);

    await sidebar.getByRole('link', { name: 'My Fees' }).click();
    await page.waitForURL('**/me/fees');
    await expect(page.getByRole('heading', { name: 'My Fees' })).toBeVisible();
  });
});
