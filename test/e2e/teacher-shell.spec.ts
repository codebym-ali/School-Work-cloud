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
  const TABS = ['Home', 'Attendance', 'Week', 'More'];

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

  /**
   * T1: the shell follows the person, not the role table.
   *
   * ⚠️ **This is the case the old rule silently excluded.** `usesTeacherShell` used to be
   * `primaryRole(roles)?.role === 'TEACHER'`, and `primaryRole` returns the first match in
   * `ROLE_INFO` order where TEACHER sits **7th** — so a teacher who also kept the books got the
   * Accountant shell with no tab bar and no Home, **on a phone as well as a laptop**. In a small
   * school one person wearing two hats is normal staffing, so this is the common case, not an edge.
   *
   * ACCOUNTANT rather than ADMISSION_CONTROLLER because the API refuses a second admission officer
   * per campus, which would make this spec fight the seed data for demo's existing one.
   */
  test('a teacher who also keeps the books still gets the teacher app', async ({ page, browser }) => {
    await gotoApp(page);
    const ts = Date.now();
    const email = `dual-${ts}@e2e.local`;
    const password = 'Dual!Secret12';
    const campuses = await apiSetupGet<{ id: string }[]>(page, '/campuses');
    const created = await apiSetupPost<{ id: string }>(page, '/users', {
      email, password, roles: ['TEACHER', 'ACCOUNTANT'], campusId: campuses[0].id,
    });

    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const dual = await ctx.newPage();
      try {
        await dual.goto('/login');
        await dual.getByLabel('Email').fill(email);
        await dual.getByLabel('Password').fill(password);
        await dual.getByRole('button', { name: /sign in/i }).click();

        // Lands on the teacher home, not the accountant's dashboard — they are being handed the
        // teacher app, so starting them on the other job contradicts it.
        //
        // Two steps rather than `waitForURL('**/home')`: that spends the full 30s test budget and
        // then reports only "timeout", while this settles as soon as login redirects anywhere and
        // then says **"expected /home, received /dashboard"**. When this breaks, the landing page
        // is the whole question, so the failure should name it.
        await dual.waitForURL((u) => !u.pathname.startsWith('/login'));
        await expect(dual).toHaveURL(/\/home$/);
        await expect(dual.locator('.sidebar')).toContainText('Teacher');

        const sidebar = dual.locator('.sidebar');
        for (const label of TABS) {
          await expect(sidebar.getByRole('link', { name: label, exact: true })).toBeVisible();
        }

        // **The accounting job is not lost — it moved.** `/me-more` is built from the person's
        // roles, so it still carries every screen the accountant shell used to show in its sidebar.
        // Asserting this is what stops "give the teacher an app" from quietly meaning "take the
        // other half of their work away".
        await dual.getByRole('link', { name: 'More', exact: true }).click();
        await dual.waitForURL('**/me-more');
        for (const label of ['Dashboard', 'Fees', 'Payment submissions', 'Reports']) {
          await expect(dual.getByRole('link', { name: label, exact: true })).toBeVisible();
        }
      } finally {
        // Best-effort: after a timeout the context may already be tearing down, and a throw here
        // would be reported instead of the assertion that actually failed.
        await ctx.close().catch(() => undefined);
      }
    } finally {
      await apiSetupDelete(page, `/users/${created.id}`);
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
