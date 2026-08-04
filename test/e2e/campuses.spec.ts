import { test, expect } from '@playwright/test';
import { gotoApp, fieldInput, fieldSelect, apiSetupGet, apiSetupDelete } from './helpers';

/**
 * Campuses screen (§23) against the live stack: each campus shows its users grouped by role
 * with a per-campus login link; the owner adds a campus-admin login inline, and duplicate
 * campus names are rejected.
 */
test.describe('campuses', () => {
  test('owner adds a campus user inline; duplicate campus name is rejected', async ({ page }) => {
    const email = `ca${Date.now()}@demo.pk`;
    await gotoApp(page, '/campuses');

    // The per-campus login link is a button now, not the `Login link:` text this asserted for.
    await expect(page.getByRole('button', { name: /Campus login/ }).first()).toBeVisible();

    // ACCOUNTANT, deliberately not CAMPUS_ADMIN: that is a **seat role** (one per campus, enforced
    // by a partial unique index), so on a configured tenant the seat is already taken and this
    // would 409 — the spec would be asserting that a real invariant is broken. The inline-add
    // flow is what is under test here; the seat rule itself is covered in `users.e2e`.
    await page.getByRole('button', { name: '+ Add user' }).first().click();
    const form = page.locator('.card').filter({ has: page.getByRole('button', { name: /Create login for/ }) }).first();
    await fieldInput(form, 'Email').fill(email);
    await fieldSelect(form, 'Role').selectOption('ACCOUNTANT');
    await fieldInput(form, 'Initial password').fill('CampusPass12345');
    await form.getByRole('button', { name: /Create login for/ }).click();

    await expect(page.locator('.toast.ok')).toContainText(/can now sign in/i);

    // Cleanup in `finally`: the first version cleaned up on the happy path only, so the run where
    // the assertion below failed left the account behind — the failure mode it existed to prevent.
    try {
      // The new user is listed under the campus's role group. `.first()` because the address also
      // appears in the still-visible success toast — a strict-mode match of 2, not a duplicate row.
      await expect(page.getByRole('cell', { name: email }).first()).toBeVisible();

      // Duplicate campus name → clean rejection (names are unique per school, case-insensitively).
      //
      // The name is read from the tenant, not hardcoded. It used to be the literal 'Main Campus',
      // which stopped matching any real campus here — so instead of proving the duplicate is
      // rejected, the spec silently **created a third campus** on the operator's tenant every run.
      // A negative test that hardcodes the value it expects to collide with becomes a creation
      // test the moment the data moves.
      const existing = await apiSetupGet<{ name: string }[]>(page, '/campuses');
      await page.locator('label:text-is("New campus name") + input').fill(existing[0].name);
      await page.getByRole('button', { name: 'Add campus' }).click();
      // Matched by CONTENT, not position: the owner carries a standing "two-factor is required"
      // banner that is also a `.toast.err`, so both a strict match (2 elements) and `.first()`
      // (the banner) were wrong. Assert the toast that says what this click did.
      await expect(page.locator('.toast.err', { hasText: /already exists/i })).toBeVisible();
    } finally {
      // This runs against the operator's real tenant, and a login per run is exactly the kind of
      // debris that ends up in a screen someone actually uses.
      const users = await apiSetupGet<{ id: string; email: string }[]>(page, '/users').catch(() => []);
      const mine = users.find((u) => u.email === email);
      if (mine) await apiSetupDelete(page, `/users/${mine.id}`);
    }
  });
});
