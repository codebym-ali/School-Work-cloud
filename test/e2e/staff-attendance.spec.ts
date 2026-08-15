import { test, expect, request } from '@playwright/test';
import { gotoApp, apiSetupGet, apiSetupPost } from './helpers';

/**
 * Staff attendance, both halves: a teacher marks themselves present, and the owner sees it.
 *
 * Unlike the admission-officer seat, staff are NOT a singleton — the suite can create its own
 * teacher, so this spec seeds and removes a throwaway one rather than borrowing a real person.
 * It leaves the tenant as it found it.
 */
test.describe('staff attendance', () => {
  test('a teacher checks themselves in, and the owner sees it on the register', async ({ page, browser }) => {
    await gotoApp(page);

    const ts = Date.now();
    const email = `att-${ts}@e2e.local`;
    const password = 'Attend!Secret12';
    const fullName = `Att Teacher ${ts}`;

    const campuses = await apiSetupGet<{ id: string; name: string }[]>(page, '/campuses');
    expect(campuses.length).toBeGreaterThan(0);

    const created = await apiSetupPost<{ staffId: string; userId: string; loginActive: boolean }>(page, '/staff', {
      email, password, fullName, campusId: campuses[0].id,
      staffType: 'TEACHER', employeeCode: `E2E-${ts}`, designation: 'Teacher',
      joinedAt: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
    });
    expect(created.loginActive).toBe(true);

    try {
      // ── The teacher's own screen ────────────────────────────────────────────
      const teacherCtx = await browser.newContext();
      const teacher = await teacherCtx.newPage();
      try {
        await teacher.goto('/staff-login');
        await teacher.getByLabel('Email').fill(email);
        await teacher.getByLabel('Password').fill(password);
        await teacher.getByRole('button', { name: /sign in/i }).click();
        await teacher.waitForURL((u) => !u.pathname.endsWith('-login') && u.pathname !== '/login');

        await teacher.goto('/my-attendance');
        await expect(teacher.getByRole('heading', { name: 'My Attendance' })).toBeVisible();

        const button = teacher.getByRole('button', { name: /Check in/ });
        // ⚠️ **Anchored on the phrase BOTH closure branches share, not on one wording.**
        // This guard used to read `/holiday or weekly off/i` — the app's copy at the time. When
        // `my-attendance` was changed to name the closure ("School is closed today — Eid" vs
        // "Today is a weekly off"), deliberately, so a teacher could tell a shut school from a
        // broken button, this guard matched neither. It then skipped nothing and failed on the
        // missing Check in button **every Saturday**, blaming the product for being right.
        // "No attendance is taken" is the sentence that states the condition, and both branches
        // end with it.
        const nonWorking = teacher.getByText(/no attendance is taken/i);

        // ⚠️ **Settle the control BEFORE branching on it.** `isVisible()` does not auto-wait, and
        // the check-in control renders from its own fetch, after the heading. Asking "is it a
        // closure?" the instant the heading appears answers "no" because NEITHER outcome has
        // rendered yet — so the guard fell through on a working day and a closed one alike, and
        // the 5s wait below then blamed the missing button. Waiting on `button.or(nonWorking)`
        // makes the branch read a settled page, whichever way the day went. (Same defect, same
        // fix, as the `fee-claims` loading race.)
        await expect(button.or(nonWorking).first()).toBeVisible();
        if (await nonWorking.isVisible().catch(() => false)) {
          test.skip(true, 'today is a non-working day for this school');
        }
        await expect(button).toBeVisible();

        // Assert the POST at the network layer: the whole security claim is that this request
        // carries no staffId, date or status, so a regression that started sending them would
        // still render a plausible screen.
        const req = teacher.waitForRequest((r) => r.url().includes('/staff-attendance/check-in') && r.method() === 'POST');
        await button.click();
        const body = (await (await req).postDataJSON()) as Record<string, unknown>;
        expect(body).toEqual({});

        // The button becomes a receipt, not a toggle — there is nothing to undo. Scoped to the
        // badge: the toast also says "Checked in at", and it is transient confirmation whereas
        // this is the persistent state.
        await expect(teacher.locator('.badge.ok').filter({ hasText: /Checked in at/ })).toBeVisible();
        await expect(teacher.getByRole('button', { name: /Check in/ })).toHaveCount(0);

        // ...and the day now appears in their own history, attributed to them.
        await expect(teacher.locator('table tbody tr').first()).toContainText('You');
      } finally {
        await teacherCtx.close();
      }

      // ── The owner's view ────────────────────────────────────────────────────
      const today = new Date().toISOString().slice(0, 10);
      await page.goto(`/staff-attendance?date=${today}`);
      await expect(page.getByRole('heading', { name: 'Staff attendance' })).toBeVisible();

      const row = page.locator('tr', { hasText: fullName });
      await expect(row).toBeVisible();
      await expect(row).toContainText('Self'); // provenance is visible to the office

      // The register lists people nobody marked — the ones worth chasing — and that count is
      // shown separately from absences, because nothing derives absence on its own yet.
      await page.getByRole('button', { name: '⚠️ Not marked' }).click();
      await expect(page).toHaveURL(/status=UNMARKED/);
      await expect(page.locator('tr', { hasText: fullName })).toHaveCount(0);

      // ── The per-person drill-down ───────────────────────────────────────────
      await page.goto(`/staff-attendance?date=${today}`);
      await page.locator('tr', { hasText: fullName }).getByRole('link', { name: fullName }).click();
      await page.waitForURL(`**/staff-attendance/${created.staffId}`);
      await expect(page.getByRole('heading', { name: fullName })).toBeVisible();
      await expect(page.getByRole('button', { name: 'All time' })).toBeVisible();

      await page.getByRole('button', { name: 'Last month' }).click();
      await expect(page.locator('table tbody tr').first()).toContainText('Self');
    } finally {
      // Soft-delete the throwaway account so the directory and the register are as we found
      // them. Attendance rows stay with the (now removed) staff profile, which is correct —
      // an attendance record is history, not a live directory entry.
      const cookies = await page.context().cookies();
      const csrf = cookies.find((c) => c.name === 'csrf')?.value ?? '';
      const ctx = await request.newContext({ baseURL: 'http://localhost:3001' });
      await page.request.delete(`http://localhost:3001/api/v1/users/${created.userId}`, {
        headers: { 'X-CSRF-Token': csrf },
      });
      await ctx.dispose();
    }
  });

  test('every count on the register is exactly what clicking it shows', async ({ page }) => {
    // The bug this guards: the "Present" tile counted present + late while the PRESENT filter
    // matched only PRESENT, so the page reported 1 and then showed "Nobody matches this
    // filter". Asserting the general invariant — a number IS its filter — rather than the one
    // case, because the next such tile would break the same way.
    await gotoApp(page, '/staff-attendance');

    // Wait for the page to SETTLE before counting: `count()` does not auto-wait, so reading it
    // immediately returns 0 and would skip this test on a working day — a guard that silently
    // disables itself is worse than no guard.
    const tiles = page.locator('.grid button.metric-link');
    const closed = page.getByText(/no register today/i);
    await expect(tiles.first().or(closed)).toBeVisible({ timeout: 10000 });
    if (await closed.isVisible().catch(() => false)) test.skip(true, 'not a working day — no register today');

    const count = await tiles.count();
    expect(count).toBeGreaterThan(1);

    for (let i = 1; i < count; i++) { // skip 0: the "Staff" tile is the unfiltered total
      const tile = tiles.nth(i);
      const label = (await tile.locator('.label').innerText()).trim();
      const shown = Number((await tile.locator('.value').innerText()).trim());

      await tile.click();
      const rows = page.locator('table tbody tr');
      const empty = page.getByText(/Nobody matches this filter|No staff records/);

      if (shown === 0) {
        await expect(empty).toBeVisible();
      } else {
        await expect(rows).toHaveCount(shown, { timeout: 7000 });
      }
      // eslint-disable-next-line no-console
      console.log(`  ${label}: tile ${shown} = rows ${shown === 0 ? 0 : await rows.count()}`);
    }
  });

  test('the dashboard leads with what is NOT known, not just with absences', async ({ page }) => {
    await gotoApp(page);
    const card = page.locator('.card').filter({ hasText: 'Staff today' });
    // Skipped rather than failed on a non-working day: the card correctly says so instead of
    // reporting every member of staff as absent, and that is the behaviour under test below.
    await expect(card).toBeVisible();
    const text = (await card.innerText()).toLowerCase();
    expect(text.includes('not marked') || text.includes('no register today')).toBe(true);
  });
});
