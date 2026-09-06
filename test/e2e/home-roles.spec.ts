import { test, expect } from '@playwright/test';
import { gotoApp, apiSetupGet, apiSetupPost, apiSetupDelete } from './helpers';

/**
 * `/home` is divided by the hats the person wears (Role-Based Home Dashboard Plan, Phase 1).
 *
 * ⚠️ **The bug this guards is a screen that under-reports work.** `/home` served TEACHER only, so a
 * teacher who also kept the staff file saw none of her HR queue there — and on a day with no
 * timetable the page told her "Nothing scheduled" while she had a second job waiting. A home screen
 * is trusted, so under-reporting is worse than not having one.
 *
 * Seeds its own TEACHER+HR_MANAGER rather than borrowing a real person: the sections follow the
 * signed-in person's roles, and a real teacher may hold a different second role. **HR_MANAGER, not
 * ADMISSION_CONTROLLER** — the admission officer is a *seat* (one per campus, partial unique index),
 * so nominating one would evict whoever holds it on every run. HR manager is not a seat.
 */
test.describe('home — divided by role', () => {
  test('a teacher who also keeps the staff file gets an HR section on her home', async ({ page, browser }) => {
    await gotoApp(page);
    const ts = Date.now();
    const email = `hometeach-${ts}@e2e.local`;
    const password = 'HomeRole!Secret12';
    const campuses = await apiSetupGet<{ id: string }[]>(page, '/campuses');
    const created = await apiSetupPost<{ id: string }>(page, '/users', {
      email, password, roles: ['TEACHER', 'HR_MANAGER'], campusId: campuses[0].id,
    });

    try {
      // The staff door is staff-web's own origin since the front-end split.
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: 'http://localhost:3006' });
      const her = await ctx.newPage();
      try {
        await her.goto('/login');
        await her.getByLabel('Email').fill(email);
        await her.getByLabel('Password').fill(password);
        await her.getByRole('button', { name: /sign in/i }).click();
        await her.waitForURL((u) => !u.pathname.endsWith('-login') && u.pathname !== '/login');
        await expect(her).toHaveURL(/\/home$/);

        // Both hats are named in the shell (role chips) …
        await expect(her.locator('.sidebar .role-chip', { hasText: 'Teacher' })).toBeVisible();
        await expect(her.locator('.sidebar .role-chip', { hasText: 'HR Manager' })).toBeVisible();

        // … and the second one now has WORK on the home screen, not just a nav entry.
        await expect(her.getByRole('heading', { name: 'HR', exact: true }).or(her.locator('.section-title', { hasText: /^HR$/ }))).toBeVisible();
        await expect(her.getByText('Staff on the books')).toBeVisible();

        // The teaching half is untouched — this is an addition, never a replacement.
        await expect(her.locator('.now')).toBeVisible();

        // A metric with rows behind it is walkable; landing on Staff is the point of showing it.
        await her.getByText('Staff on the books').click();
        await her.waitForURL('**/staff');
      } finally {
        await ctx.close().catch(() => undefined);
      }
    } finally {
      await apiSetupDelete(page, `/users/${created.id}`);
    }
  });

  /**
   * Phase 3 — the person who does not teach.
   *
   * A plain staff member (office assistant, driver, lab attendant) had **no home at all**: `/home`
   * was TEACHER-only, so they landed straight in `/my-attendance`. The trap this guards is that
   * simply granting them `/home` would have handed them the teacher's card — whose only call to
   * action is *Open attendance*, a TEACHER-gated screen — i.e. a home that dead-ends.
   */
  test('a staff member who does not teach gets their own day, not a teacher’s', async ({ page, browser }) => {
    await gotoApp(page);
    const ts = Date.now();
    const email = `plainstaff-${ts}@e2e.local`;
    const password = 'PlainStaff!Secret12';
    const campuses = await apiSetupGet<{ id: string }[]>(page, '/campuses');
    const created = await apiSetupPost<{ id: string }>(page, '/users', {
      email, password, roles: ['STAFF'], campusId: campuses[0].id,
    });

    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: 'http://localhost:3006' });
      const him = await ctx.newPage();
      try {
        await him.goto('/login');
        await him.getByLabel('Email').fill(email);
        await him.getByLabel('Password').fill(password);
        await him.getByRole('button', { name: /sign in/i }).click();
        await him.waitForURL((u) => !u.pathname.endsWith('-login') && u.pathname !== '/login');

        // He lands on a HOME now, not in the middle of a records screen.
        await expect(him).toHaveURL(/\/home$/);

        // The personal shell, but branded as himself — `panelLabel` was deliberately not widened,
        // so a driver is never told he is a Teacher.
        await expect(him.locator('.sidebar .brand')).toContainText('Staff');
        await expect(him.locator('.sidebar .role-chip', { hasText: 'Staff' })).toBeVisible();
        // …and the rail lists Home, so he can always get back to where he started (the T0 bug).
        await expect(him.locator('.sidebar').getByRole('link', { name: 'Home', exact: true })).toBeVisible();
        await expect(him.locator('.sidebar').getByRole('link', { name: 'Profile', exact: true })).toBeVisible();

        // ⚠️ No teacher card: its only button opens `/attendance`, which he may not use.
        await expect(him.locator('.now')).toHaveCount(0);
        await expect(him.getByRole('link', { name: 'Open attendance' })).toHaveCount(0);

        // His own day instead — and it walks into the screen holding the detail.
        await expect(him.locator('.section-title', { hasText: 'Your day' })).toBeVisible();
        await expect(him.getByText('Attendance this month')).toBeVisible();
        await him.getByText('Leave requests pending').click();
        await him.waitForURL('**/my-leaves');
      } finally {
        await ctx.close().catch(() => undefined);
      }
    } finally {
      await apiSetupDelete(page, `/users/${created.id}`);
    }
  });
});
