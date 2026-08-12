import { test, expect } from '@playwright/test';
import { gotoApp, fieldInput, fieldSelect, apiSetupGet, apiSetupPost, apiSetupDelete, e2eCampusId, E2E_CAMPUS_NAME } from './helpers';

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

    // TEACHER, because it is the only kind of login a campus can hold MANY of.
    //
    // ⚠️ This used to say "ACCOUNTANT, deliberately not CAMPUS_ADMIN: that is a seat role" — true
    // when written, false since 2026-08-12, when the accountant became a seat too. The spec kept
    // passing only because the E2E campus happened to have no accountant and this cleaned up after
    // itself; one failed cleanup and the seat would be taken for every later run. **A comment that
    // justifies a choice by a rule elsewhere goes stale silently when that rule moves.**
    await page.getByRole('button', { name: '+ Add user' }).first().click();
    const form = page.locator('.card').filter({ has: page.getByRole('button', { name: /Create login for/ }) }).first();
    await fieldInput(form, 'Email').fill(email);
    await fieldSelect(form, 'Role').selectOption('TEACHER');
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

  test('a filled seat names its holder instead of offering to fill it again', async ({ page }) => {
    // The screen used to list "Accountants" (plural), always offer every role, and let the API
    // answer a second one with a 409. A campus has exactly ONE accountant, campus admin and
    // admission officer — so the screen says who, before the owner types anything.
    await gotoApp(page);
    const campusId = await e2eCampusId(page);
    const email = `seat${Date.now()}@demo.pk`;
    const holder = await apiSetupPost<{ id: string }>(page, '/users', {
      email, roles: ['ACCOUNTANT'], campusId, password: 'SeatPass123456',
    });

    try {
      await page.goto('/campuses');
      const card = page.locator('.card').filter({ has: page.getByRole('heading', { name: E2E_CAMPUS_NAME, exact: true }) });
      await expect(card).toBeVisible();

      // Singular label, and the holder is on screen.
      await expect(card).toContainText('Accountant');
      // `exact`: the row's select-checkbox cell carries the address in its aria-label
      // ("Select <email>"), so a loose match finds two cells and fails strict mode.
      await expect(card.getByRole('cell', { name: email, exact: true })).toBeVisible();

      // ⚠️ The point of the change: the add form must not OFFER the seat that is taken.
      await card.getByRole('button', { name: '+ Add user' }).click();
      const form = card.locator('.card').filter({ has: page.getByRole('button', { name: /Create login for/ }) });
      const accountantOption = form.locator('option', { hasText: 'Accountant' });
      await expect(accountantOption).toBeDisabled();
      await expect(accountantOption).toContainText(email);   // names WHO holds it, not just "unavailable"

      // An unfilled seat is not hidden either — it is a gap worth naming, because nobody can do
      // the thing it exists for. (No admission officer is seeded on this campus.)
      await expect(card).toContainText(/Not assigned/);
    } finally {
      await apiSetupDelete(page, `/users/${holder.id}`);
    }
  });
});
