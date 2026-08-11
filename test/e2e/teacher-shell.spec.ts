import { test, expect } from '@playwright/test';
import { gotoApp, apiSetupGet, apiSetupPost, apiSetupDelete } from './helpers';

/**
 * The teacher's navigation is the same at every width (Teacher App Shell Plan, T0).
 *
 * ⚠️ **This exists because of a regression nobody noticed for two days.** `/home` is `hidden: true`
 * in `NAV` so the phone tab bar can own it — correct on a phone, and it stranded the route above
 * 720px, where the teacher got the administrator's eight-link sidebar with **no Home in it**. A
 * teacher landed on Home, clicked anything, and could only get back with the browser's back button.
 * Nothing failed, because nothing looked.
 *
 * The load-bearing assertion is therefore **at desktop width**, which is the half that was broken.
 *
 * Seeds and removes its own teacher rather than borrowing a real one — the same reason
 * `staff-attendance.spec.ts` does: the shell depends on the signed-in person's roles, and a real
 * teacher may hold a second role that changes which shell they get.
 */
test.describe('teacher shell', () => {
  // Keeps the shared OWNER session: `page` is what creates and removes the throwaway teacher.
  // The teacher gets `browser.newContext()`, which is already clean — clearing storageState here
  // instead would log the owner out and take the setup with it.
  const TABS = ['Home', 'Attendance', 'Week', 'Me'];

  test('a teacher gets the same four destinations on a phone and on a laptop', async ({ page, browser }) => {
    // Owner session, only to create the throwaway teacher.
    await gotoApp(page);
    const ts = Date.now();
    const email = `shell-${ts}@e2e.local`;
    const password = 'Shell!Secret12';
    const campuses = await apiSetupGet<{ id: string }[]>(page, '/campuses');
    const created = await apiSetupPost<{ userId: string; loginActive: boolean }>(page, '/staff', {
      email, password, fullName: `Shell Teacher ${ts}`, campusId: campuses[0].id,
      staffType: 'TEACHER', employeeCode: `E2E-SHELL-${ts}`, designation: 'Teacher',
      joinedAt: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
    });
    expect(created.loginActive).toBe(true);

    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const teacher = await ctx.newPage();
      try {
        await teacher.goto('/login');
        await teacher.getByLabel('Email').fill(email);
        await teacher.getByLabel('Password').fill(password);
        await teacher.getByRole('button', { name: /sign in/i }).click();
        // A teacher's landing path IS /home — if that ever changes, this waits forever and says so.
        await teacher.waitForURL('**/home');

        // ── Desktop: the half that was broken ──────────────────────────────────
        const sidebar = teacher.locator('.sidebar');
        await expect(sidebar).toBeVisible();
        for (const label of TABS) {
          await expect(sidebar.getByRole('link', { name: label, exact: true })).toBeVisible();
        }
        // The administrator's filing system must NOT be what a teacher sees. "MY PORTAL" is an
        // admin's word for a teacher's own things, and its presence means the wrong nav rendered.
        await expect(teacher.locator('.sidebar .group-label')).toHaveCount(0);

        // The regression itself: leave Home, and be able to come back.
        await teacher.getByRole('link', { name: 'Attendance', exact: true }).click();
        await teacher.waitForURL('**/attendance');
        await teacher.locator('.sidebar').getByRole('link', { name: 'Home', exact: true }).click();
        await expect(teacher).toHaveURL(/\/home$/);

        // ── Phone: same four, as a bottom bar, with the sidebar gone ───────────
        await teacher.setViewportSize({ width: 375, height: 812 });
        const tabbar = teacher.locator('.tabbar');
        await expect(tabbar).toBeVisible();
        await expect(tabbar.locator('.tab-label')).toHaveText(TABS);
        // Two navigations on one screen is how a user learns to trust neither.
        await expect(sidebar).toBeHidden();
      } finally {
        await ctx.close();
      }
    } finally {
      await apiSetupDelete(page, `/users/${created.userId}`);
    }
  });

  test('another role is untouched — the admin sidebar is still the admin sidebar', async ({ page }) => {
    // The change is scoped to TEACHER by `usesMobileShell`. An owner losing their nav to a
    // teacher-shaped rail would be a far worse bug than the one being fixed, and it would be
    // invisible in a suite that only ever looks at the teacher.
    await gotoApp(page);
    await expect(page.locator('.sidebar .group-label').first()).toBeVisible();
    await expect(page.locator('.tabbar')).toHaveCount(0);
  });
});
