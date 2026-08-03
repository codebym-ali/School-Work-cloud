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
        await teacher.goto('/login');
        await teacher.getByLabel('Email').fill(email);
        await teacher.getByLabel('Password').fill(password);
        await teacher.getByRole('button', { name: /sign in/i }).click();
        await teacher.waitForURL((u) => !u.pathname.startsWith('/login'));

        await teacher.goto('/my-attendance');
        await expect(teacher.getByRole('heading', { name: 'My Attendance' })).toBeVisible();

        const button = teacher.getByRole('button', { name: /Check in/ });
        const nonWorking = teacher.getByText(/holiday or weekly off/i);
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
