import { test, expect } from '@playwright/test';
import { gotoApp, apiSetupGet, seedClassSection } from './helpers';

/**
 * The checks the Classes refactor plan listed as a manual browser pass (§8) and never got —
 * first-run, responsive, keyboard, and the client-side seat guard. Automated instead of
 * eyeballed, because a checklist that depends on somebody remembering to look is a checklist
 * that stops being run.
 */
test.describe('classes — first run, responsive, keyboard', () => {
  test('a school with no classes yet can still create its first one', async ({ page }) => {
    // The near-miss the plan called out: Setup stopped rendering the class manager, so if this
    // path is broken a brand-new school cannot start at all. Intercepted rather than seeded —
    // proving it needs a tenant with zero classes, and provisioning one per run would leave
    // throwaway tenants behind (the leak we already have from admin.spec).
    await gotoApp(page);
    await page.route('**/api/v1/classes*', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('/classes');

    await expect(page.getByText(/No classes yet/i)).toBeVisible();
    // The primary action must be present, enabled, and not hidden behind a tools flag.
    const name = page.locator('label:text-is("Class name") + input');
    await expect(name).toBeVisible();
    await name.fill('Nursery');
    // The campus picker only renders for a multi-campus school (a single campus is auto-selected),
    // and this tenant grew a second campus after the spec was written — so the spec sat red while
    // "Choose a campus first." was the correct answer. Pick one when asked; the assertion below is
    // about the button being reachable, not about how many campuses happen to exist today.
    const campus = page.locator('label:text-is("Campus") + select');
    if (await campus.count()) await campus.selectOption({ index: 1 });
    await expect(page.getByRole('button', { name: 'Add class' })).toBeEnabled();
    // The placeholder must read as an example, not as a filled-in value — people used to click
    // Add class and wonder why nothing happened.
    await page.reload();
    await expect(page.locator('label:text-is("Class name") + input')).toHaveAttribute('placeholder', /e\.g\./);
  });

  test('the selected section is in the URL and survives the back button', async ({ page }) => {
    await gotoApp(page);
    const { classId, sectionId, className } = await seedClassSection(page, { name: 'E2E Classes UX' });
    try {
      await page.goto(`/classes/${classId}`);
      await page.locator('tr', { hasText: 'Section A' }).getByRole('button', { name: 'Open' }).click();
      await expect(page).toHaveURL(new RegExp(`section=${sectionId}`));

      // Navigate away and back: the pane must reopen, not reset to the section list.
      await page.goto('/classes');
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`section=${sectionId}`));
      await expect(page.getByText(`${className} · Section A`)).toBeVisible();

      // A reload is the other half of "in the URL" — a shared link has to work.
      await page.reload();
      await expect(page.getByText(`${className} · Section A`)).toBeVisible();
    } finally {
      const cookies = await page.context().cookies();
      const csrf = cookies.find((c) => c.name === 'csrf')?.value ?? '';
      const del = (p: string) => page.request.delete(`/api/v1${p}`, { headers: { 'X-CSRF-Token': csrf } });
      await del(`/sections/${sectionId}`);
      for (const s of await apiSetupGet<{ id: string }[]>(page, `/subjects?classId=${classId}`)) await del(`/subjects/${s.id}`);
      await del(`/classes/${classId}`);
    }
  });

  test('the class list is usable on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await gotoApp(page, '/classes');
    await expect(page.getByRole('heading', { name: 'Classes' })).toBeVisible();

    // The body must never scroll sideways — tables get their own scroll container instead.
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1); // sub-pixel rounding only

    // Navigation still exists below 720px: the sidebar becomes a drawer, not nothing.
    const toggle = page.locator('.nav-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.sidebar')).toBeVisible();
  });

  test('seats cannot be cut below the students already sitting in them', async ({ page }) => {
    await gotoApp(page);
    // Needs a section that actually has students, so it uses a real one and never saves —
    // the guard is a client-side block, and the point is that Save is unreachable, not that
    // the server refuses afterwards.
    const sections = await apiSetupGet<{ id: string; classId: string; name: string; enrolled: number | null }[]>(page, '/sections');
    const occupied = sections.find((s) => (s.enrolled ?? 0) > 0);
    test.skip(!occupied, 'no section on this tenant has enrolled students');

    await page.goto(`/classes/${occupied!.classId}?section=${occupied!.id}`);

    const editor = page.getByRole('button', { name: 'Edit name & seats' });
    const seats = page.locator('label:text-is("Seats") + input');
    const save = page.getByRole('button', { name: 'Save', exact: true });

    /**
     * ⚠️ Verify each interaction instead of firing and hoping.
     *
     * This case failed intermittently under load (five dev servers + API + worker + the suite) on
     * `toBeEnabled`, and passed in isolation — the classic signature of a click racing the page's
     * own data load. The section fetch re-renders this panel, so a click that lands mid-render is
     * swallowed and the editor never opens; the failure then surfaces three assertions later,
     * reading as "the seats guard is broken".
     *
     * `toPass` re-clicks until the editor is actually open. Same treatment that stabilised
     * `timings` — the fix there was never fewer interactions, it was VERIFIED ones.
     */
    await expect(async () => {
      if (await seats.count() === 0) await editor.click();
      await expect(seats).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });

    await expect(save).toBeEnabled();

    // And the fill is read back: a value written mid-render is discarded silently, which would
    // leave Save enabled and look like a missing guard rather than a lost keystroke.
    const below = String(occupied!.enrolled! - 1);
    await expect(async () => {
      await seats.fill(below);
      await expect(seats).toHaveValue(below, { timeout: 1000 });
    }).toPass({ timeout: 10_000 });

    await expect(save).toBeDisabled();
    // ...and it says why, next to the field, rather than failing silently.
    await expect(page.getByText(/already enrolled — seats cannot be below/)).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('the class row menu is reachable and announced to a screen reader', async ({ page }) => {
    await gotoApp(page, '/classes');

    // ⚠️ **Not `.first()`.** The reorder items render only when the class has a neighbour to
    // swap with (`class-card.tsx`), so a class alone in its campus correctly shows no "Move
    // earlier". This passed for months only because the tenant was full of fixture classes and the
    // first card always had siblings; clearing them out turned a true statement about the UI into a
    // failing test. Pick a class that provably has one.
    const all = await apiSetupGet<{ id: string; name: string; campusId: string }[]>(page, '/classes');
    const byCampus = new Map<string, string[]>();
    for (const k of all) byCampus.set(k.campusId, [...(byCampus.get(k.campusId) ?? []), k.name]);
    const pair = [...byCampus.values()].find((names) => names.length > 1);
    test.skip(!pair, 'no campus has two classes to reorder');

    const menu = page.locator('.card')
      .filter({ has: page.getByRole('link', { name: pair![1], exact: true }) })
      .locator('button[aria-haspopup="menu"]').first();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toHaveAttribute('aria-label', /More actions/);

    // Operable from the keyboard alone, not just by mouse.
    await menu.focus();
    await page.keyboard.press('Enter');
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('menu')).toBeVisible();
    // Worded items, not bare icons — the plan's reason for retiring the ↑ ↓ buttons.
    await expect(page.getByRole('menuitem', { name: 'Move earlier' })).toBeVisible();
  });
});
