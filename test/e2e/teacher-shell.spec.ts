import { test, expect } from '@playwright/test';
import { gotoApp, apiSetupGet, apiSetupPost, apiSetupDelete, e2eCampusId } from './helpers';

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
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: 'http://localhost:3006' });
      const teacher = await ctx.newPage();
      try {
        // ⚠️ The staff door is **staff-web:3006/login** — its own origin (this context's `baseURL`),
        // not the marketing chooser at apps/web:3001/login. The wait below stays `!== '/login'` (not
        // `!startsWith('/login')`) so it only clears once the form has submitted and redirected away.
        await teacher.goto('/login');
        await teacher.getByLabel('Email').fill(email);
        await teacher.getByLabel('Password', { exact: true }).fill(password);
        await teacher.getByRole('button', { name: /sign in/i }).click();
        await teacher.waitForURL((u) => !u.pathname.endsWith('-login') && u.pathname !== '/login');
        await expect(teacher).toHaveURL(/\/home$/);

        // ⚠️ **A single-hat teacher's home must be exactly what it always was.** Dividing `/home`
        // by role (Role-Based Home Dashboard Plan) is a pure ADDITION for the ~90% who wear one
        // hat; a stray "Admissions"/"HR" heading here would mean the sections are keyed on
        // something other than the roles she holds. The multi-hat half is `home-roles.spec.ts`.
        await expect(teacher.locator('.section-title', { hasText: /^(Admissions|HR)$/ })).toHaveCount(0);
        await expect(teacher.locator('.section-title', { hasText: 'Needs you today' })).toHaveCount(0);

        // ── T0: the full teacher menu on the desktop panel ────────────────────
        // The desktop panel now lists every screen the teacher can open directly (operator
        // 2026-09-01) — no longer a four-item stub with the rest hidden behind "More".
        const sidebar = teacher.locator('.sidebar');
        await expect(sidebar).toBeVisible();
        for (const label of ['Home', 'Attendance', 'My Classes', 'Exams & Results', 'Profile']) {
          await expect(sidebar.getByRole('link', { name: label, exact: true })).toBeVisible();
        }
        // "More" is gone from the desktop panel — everything it hid is listed above, and Profile is
        // pinned in its place.
        await expect(sidebar.getByRole('link', { name: 'More', exact: true })).toHaveCount(0);
        // ⚠️ Her OWN records are not in the work panel (operator 2026-09-06) — they live behind
        // Profile, so the panel is the school's work and Profile is the employee. `My Classes`
        // above proves the line is the `My Portal` GROUP, not the words "My …".
        for (const own of ['My Attendance', 'My Leaves', 'My Payslips', 'My Timetable']) {
          await expect(sidebar.getByRole('link', { name: own, exact: true })).toHaveCount(0);
        }

        // …and they ARE reachable there, which is what stops the move from being a deletion.
        await sidebar.getByRole('link', { name: 'Profile', exact: true }).click();
        await teacher.waitForURL('**/profile');
        for (const own of ['My Attendance', 'My Leaves', 'My Payslips']) {
          await expect(teacher.getByRole('link', { name: own, exact: true })).toBeVisible();
        }
        await teacher.goto('/home');
        // Still NOT the administrator's grouped filing system: one flat list, no group labels.
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
   * ⚠️ **ACCOUNTANT IS A SEAT TOO — the note that used to sit here was wrong.** It read "ACCOUNTANT
   * rather than ADMISSION_CONTROLLER because the API refuses a second admission officer per campus",
   * but the accountant is *also* one-per-campus, so seeding onto the school's first campus was a
   * time bomb: it passed only while that campus happened to have no accountant. It went off the day
   * the operator appointed one — `409 This campus already has an accountant`. The spec now seeds
   * into the suite's own `E2E Automation` campus, which exists for exactly this reason and has its
   * own free seat, so it never fights the school's real staffing.
   */
  test('a teacher who also keeps the books still gets the teacher app', async ({ page, browser }) => {
    await gotoApp(page);
    const ts = Date.now();
    const email = `dual-${ts}@e2e.local`;
    const password = 'Dual!Secret12';
    const created = await apiSetupPost<{ id: string }>(page, '/users', {
      email, password, roles: ['TEACHER', 'ACCOUNTANT'], campusId: await e2eCampusId(page),
    });

    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: 'http://localhost:3006' });
      const dual = await ctx.newPage();
      try {
        await dual.goto('/login');
        await dual.getByLabel('Email').fill(email);
        await dual.getByLabel('Password', { exact: true }).fill(password);
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

        // **The accounting job is not lost — it is listed directly.** The desktop panel now shows
        // every screen the person can reach, so a teacher-accountant's Dashboard, Fees, Payment
        // submissions and Reports sit in the panel itself rather than behind "More". This is what
        // stops "give the teacher an app" from quietly meaning "take the other half of their work
        // away". (On a phone those still live under the "More" tab — the bar holds only four.)
        const nav = dual.locator('.sidebar');
        for (const label of ['Dashboard', 'Fees', 'Payment submissions', 'Reports']) {
          await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
        }
        await expect(nav.getByRole('link', { name: 'More', exact: true })).toHaveCount(0);
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
