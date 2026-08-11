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
   * ⚠️ **One test, one login — and that constraint is not cosmetic.** The §29 limiter allows 5
   * logins per IP per 15 minutes, and the suite was already at 5 before this file existed. Adding
   * a second teacher session here took it to **6**, and a full run started failing on whichever
   * spec happened to log in last — reported as a 30-second navigation timeout, not as a rate
   * limit, so it read as a broken feature. See the task filed for the durable fix (a shared
   * teacher `storageState` setup project); until then, teacher-side cases share one session.
   *
   * The user is **TEACHER + ACCOUNTANT** rather than a plain teacher because that exercises the
   * same shell path *plus* the case T1 exists for: `usesTeacherShell` returns true for both, so
   * nothing about the shell is left unasserted by choosing the harder one.
   *
   * ACCOUNTANT rather than ADMISSION_CONTROLLER because the API refuses a second admission officer
   * per campus, which would make this fight demo's seed data.
   */
  test('a teacher — including one who also keeps the books — gets the app at every width', async ({ page, browser }) => {
    await gotoApp(page);
    const ts = Date.now();
    const email = `shell-${ts}@e2e.local`;
    const password = 'Shell!Secret12';
    const campuses = await apiSetupGet<{ id: string }[]>(page, '/campuses');
    const created = await apiSetupPost<{ id: string }>(page, '/users', {
      email, password, roles: ['TEACHER', 'ACCOUNTANT'], campusId: campuses[0].id,
    });

    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const teacher = await ctx.newPage();
      try {
        await teacher.goto('/login');
        await teacher.getByLabel('Email').fill(email);
        await teacher.getByLabel('Password').fill(password);
        await teacher.getByRole('button', { name: /sign in/i }).click();

        // ── T1: lands on the teacher home, not the accountant's dashboard ──────
        // Two steps rather than `waitForURL('**/home')`: that spends the full 30s test budget and
        // then reports only "timeout", while this settles as soon as login redirects anywhere and
        // then says **"expected /home, received /dashboard"**. When this breaks, the landing page
        // is the whole question, so the failure should name it.
        await teacher.waitForURL((u) => !u.pathname.startsWith('/login'));
        await expect(teacher).toHaveURL(/\/home$/);
        await expect(teacher.locator('.sidebar')).toContainText('Teacher');

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
        // viewport under it — a phone component stretched to fill a laptop. The cap is what makes
        // a 26px headline span a readable measure instead of ~90 characters.
        const grid = teacher.locator('.home-grid');
        await expect(grid).toBeVisible();
        const wide = await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns);
        // Asserted as "two tracks" rather than exact pixels, which would break on any future width
        // tweak without anything actually being wrong.
        expect(wide.split(' ').length).toBe(2);

        // ── T1: the accounting job is not lost — it moved under More ──────────
        // Without this, "give the teacher an app" could quietly have meant "take the other half of
        // their work away", and no test would have noticed.
        await teacher.getByRole('link', { name: 'More', exact: true }).click();
        await teacher.waitForURL('**/me-more');
        for (const label of ['Dashboard', 'Fees', 'Payment submissions', 'Reports']) {
          await expect(teacher.getByRole('link', { name: label, exact: true })).toBeVisible();
        }

        // ── T0/T3: the phone — same four as a bottom bar, one column, no sideways scroll ──
        await teacher.goto('/home');
        await teacher.setViewportSize({ width: 375, height: 812 });
        const tabbar = teacher.locator('.tabbar');
        await expect(tabbar).toBeVisible();
        await expect(tabbar.locator('.tab-label')).toHaveText(TABS);
        // Two navigations on one screen is how a user learns to trust neither.
        await expect(sidebar).toBeHidden();

        const narrow = await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns);
        expect(narrow.split(' ').length).toBe(1);
        expect(await teacher.evaluate(() =>
          document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
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
