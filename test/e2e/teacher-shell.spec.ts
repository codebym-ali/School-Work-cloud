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

  /**
   * ⚠️ **This was briefly ONE test, merged with two others to "save a login". That was wrong.**
   *
   * I diagnosed three intermittent failures as the §29 login limiter and collapsed the plain-teacher
   * and dual-role cases into a single session to stay under it. **The limiter does not fire against
   * this dev server at all** — measured 2026-08-11, seven consecutive logins returned 200 with
   * `RATE_LIMIT_ENABLED` set both ways — so it cannot have caused them. The likelier cause is
   * `next dev` compiling a route on first visit and eating the 30-second budget.
   *
   * **Split back apart 2026-08-11**: there is no login budget to economise against, and one test
   * asserting two different users' shells is harder to read than two.
   */
  test('a plain teacher gets the same four destinations on a phone and on a laptop', async ({ page, browser }) => {
    await gotoApp(page);
    const ts = Date.now();
    const email = `shell-${ts}@e2e.local`;
    const password = 'Shell!Secret12';
    const campuses = await apiSetupGet<{ id: string }[]>(page, '/campuses');
    const created = await apiSetupPost<{ id: string }>(page, '/users', {
      email, password, roles: ['TEACHER'], campusId: campuses[0].id,
    });

    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const teacher = await ctx.newPage();
      try {
        // ⚠️ `/staff-login`, not `/login`. `/login` is a CHOOSER now, not a form — filling
        // "Email" there finds nothing. And the wait below cannot be `!startsWith('/login')`,
        // because `/staff-login` does not start with `/login` and the guard would pass before the
        // form was ever submitted.
        await teacher.goto('/staff-login');
        await teacher.getByLabel('Email').fill(email);
        await teacher.getByLabel('Password').fill(password);
        await teacher.getByRole('button', { name: /sign in/i }).click();
        await teacher.waitForURL((u) => !u.pathname.endsWith('-login') && u.pathname !== '/login');
        await expect(teacher).toHaveURL(/\/home$/);

        // ── T0: the same four destinations, at desktop width ──────────────────
        const sidebar = teacher.locator('.sidebar');
        await expect(sidebar).toBeVisible();
        for (const label of TABS) {
          await expect(sidebar.getByRole('link', { name: label, exact: true })).toBeVisible();
        }
        // The administrator's filing system must NOT be what a teacher sees. "MY PORTAL" is an
        // admin's word for a teacher's own things, and its presence means the wrong nav rendered.
        await expect(teacher.locator('.sidebar .group-label')).toHaveCount(0);

        // The regression that started this plan: leave Home, and be able to come back.
        await teacher.getByRole('link', { name: 'Attendance', exact: true }).click();
        await teacher.waitForURL('**/attendance');
        await sidebar.getByRole('link', { name: 'Home', exact: true }).click();
        await expect(teacher).toHaveURL(/\/home$/);

        // ── T3: two columns above 1024px ──────────────────────────────────────
        // Measured before T3 at 1440x900: the "now" card was 1164px wide with 474px of empty
        // viewport under it — a phone component stretched to fill a laptop.
        const grid = teacher.locator('.home-grid');
        await expect(grid).toBeVisible();
        // Asserted as "two tracks" rather than exact pixels, which would break on any future width
        // tweak without anything actually being wrong.
        expect((await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns)).split(' ').length).toBe(2);

        // ── T0/T3: the phone — same four as a bottom bar, one column, no sideways scroll ──
        await teacher.setViewportSize({ width: 375, height: 812 });
        const tabbar = teacher.locator('.tabbar');
        await expect(tabbar).toBeVisible();
        await expect(tabbar.locator('.tab-label')).toHaveText(TABS);
        // Two navigations on one screen is how a user learns to trust neither.
        await expect(sidebar).toBeHidden();
        expect((await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns)).split(' ').length).toBe(1);
        expect(await teacher.evaluate(() =>
          document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      } finally {
        await ctx.close().catch(() => undefined);
      }
    } finally {
      await apiSetupDelete(page, `/users/${created.id}`);
    }
  });

  /**
   * T1: the shell follows the person, not the role table.
   *
   * ⚠️ **The case the old rule silently excluded.** `usesTeacherShell` used to be
   * `primaryRole(roles)?.role === 'TEACHER'`, and `primaryRole` returns the first match in
   * `ROLE_INFO` order where TEACHER sits **7th** — so a teacher who also kept the books got the
   * Accountant shell with no tab bar and no Home, **on a phone as well as a laptop**. In a small
   * school one person wearing two hats is normal staffing, so this is the common case.
   *
   * ACCOUNTANT rather than ADMISSION_CONTROLLER because the API refuses a second admission officer
   * per campus, which would make this spec fight demo's seed data.
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
        await dual.goto('/staff-login');
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
        await dual.waitForURL((u) => !u.pathname.endsWith('-login') && u.pathname !== '/login');
        await expect(dual).toHaveURL(/\/home$/);
        // The name in the corner follows the shell, so the two cannot disagree about who you are.
        await expect(dual.locator('.sidebar')).toContainText('Teacher');
        await expect(dual.locator('.sidebar').getByRole('link', { name: 'Home', exact: true })).toBeVisible();

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
