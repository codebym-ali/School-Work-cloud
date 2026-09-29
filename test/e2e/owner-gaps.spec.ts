import { test, expect, type Browser, type Page } from '@playwright/test';
import { apiSetupGet, gotoApp } from './helpers';

/**
 * Owner Gap Resolution Plan — the browser checks (item 8).
 *
 * The integration suite proves the API; these prove the SCREENS agree with it, which is where most of the gap
 * register came from: a capability the API allowed and no screen reached, or a button the API would refuse.
 *
 * Budget: two form logins (accountant, campus admin) on top of the shared owner session — under the §29
 * login limiter.
 */
const STAFF = 'http://localhost:3006';

async function staffLogin(browser: Browser, email: string, password: string, url = `${STAFF}/login`): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: STAFF, storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.locator('.sidebar')).toBeVisible();
  return page;
}

test.describe('owner gaps — screens match the API', () => {
  test('the owner sees Reverse on a paid receipt; an accountant is offered it nowhere', async ({ page, browser }) => {
    await gotoApp(page);
    const paid = await apiSetupGet<{ data: Array<{ studentId: string }> }>(page, '/fees/invoices?status=PAID&pageSize=50');
    expect(paid.data.length, 'the demo tenant needs one paid invoice — run fees.spec first').toBeGreaterThan(0);
    const studentId = paid.data[0].studentId;

    await page.goto(`/students?student=${studentId}`);
    await expect(page.getByRole('button', { name: 'Reverse', exact: true }).first()).toBeVisible();

    // FEE_REVERSE_WAIVE_ROLES excludes ACCOUNTANT, matching @Roles on the route.
    const acct = await staffLogin(browser, 'accountant@demo.pk', 'Money!Secret12');
    await acct.goto('/fees');
    await expect(acct.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(acct.getByRole('button', { name: 'Reverse', exact: true })).toHaveCount(0);
    await expect(acct.getByRole('button', { name: 'Waive', exact: true })).toHaveCount(0);
    // Students is not on the accountant's door at all, so the profile card with Reverse cannot be reached.
    await expect(acct.locator('.sidebar').getByRole('link', { name: 'Students', exact: true })).toHaveCount(0);
    await acct.context().close();
  });

  test('every report runs without typing an id', async ({ page }) => {
    // Phase 1d: a gallery of report cards grouped by category; each opens its own view (`?report=key`).
    await gotoApp(page, '/reports');
    const titles = await page.locator('button.ov-rcard .ov-rcard-title').allInnerTexts();
    expect(titles.length).toBeGreaterThanOrEqual(7);
    const keys = ['class-strength', 'attendance-register', 'daily-collection', 'defaulters', 'fee-ledger', 'exam-summary', 'sms-usage'];

    for (const key of keys) {
      // A report with no required choice runs as soon as it opens — catch that request.
      const auto = page.waitForResponse((r) => r.url().includes(`/reports/${key}`) && r.request().method() === 'GET', { timeout: 8000 }).catch(() => null);
      await gotoApp(page, `/reports?report=${key}`);
      await expect(page.getByRole('button', { name: '← All reports' })).toBeVisible();
      // No input on the page may ask for a raw id.
      await expect(page.locator('input[placeholder*="id" i], label:text-matches("(student|section|exam)Id", "i")')).toHaveCount(0);

      if (key === 'fee-ledger') {
        const box = page.locator('#rep-student');
        // Typed as a person would, by name. "Ahmed" is in the BASE demo seed; "Moeez" came from the optional
        // seed-test-users script, so the step failed on any stack where that had not been run.
        await box.pressSequentially('Ahm');
        const option = page.locator('#rep-student-list').getByRole('option').first();
        await expect(option).toBeVisible();
        await option.click();
      }
      for (const id of ['#rep-section', '#rep-exam']) {
        const s = page.locator(id);
        if (await s.count()) {
          // A searchable combobox (not a native <select>): open it and take the first option, as a person would.
          await s.click();
          const first = page.getByRole('listbox').getByRole('option').first();
          await expect(first).toBeVisible();
          await first.click();
        }
      }

      const run = page.getByRole('button', { name: /^(Run report|Update)$/ });
      if (await run.count()) {
        await expect(run, `${key}: Run should be enabled once choices are made`).toBeEnabled();
        const res = page.waitForResponse((r) => r.url().includes(`/reports/${key}`) && r.request().method() === 'GET');
        await run.click();
        expect((await res).status(), `${key} report`).toBe(200);
      } else {
        expect((await auto)?.status(), `${key} report (runs on open)`).toBe(200);
      }
      // Asserted by what the report SHOWS, not by the absence of an error style: the two-factor banner and
      // Next.js's route announcer both match the generic error selectors.
      await expect(page.locator('table').or(page.getByText('Nothing to report for these choices.'))).toBeVisible();
    }
  });

  test('a campus admin signs in through the link the owner copies from Campus Hub', async ({ page, browser }) => {
    await gotoApp(page, '/campuses');
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: /Campus login/ }).first().click();
    const popup = await popupPromise;
    const link = popup.url();
    await popup.close();

    // The staff door, not the owner door that refused campus admins with "invalid credentials".
    expect(link).toMatch(/^http:\/\/localhost:3006\/login\?campus=/);
    const admin = await staffLogin(browser, 'campusadmin@demo.pk', 'Campus!Secret12', link);
    expect(admin.url()).not.toContain('/login');
    await admin.context().close();
  });

  test('the new owner screens open and load their data', async ({ page }) => {
    const errors: string[] = [];
    page.on('response', (r) => { if (r.url().includes('/api/v1/') && r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });

    await gotoApp(page, '/payroll');
    await expect(page.getByRole('heading', { name: 'Payroll', level: 1 })).toBeVisible();
    await expect(page.getByText(/Payroll history/)).toBeVisible();
    await expect(page.getByText('Loading…')).toHaveCount(0);

    await gotoApp(page, '/defaulters');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    await gotoApp(page, '/activity');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    await gotoApp(page, '/promotion');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // Broadcast: checking the audience spends nothing and states a count.
    await gotoApp(page, '/sms');
    await page.locator('#bc-body').fill('E2E audience check — not sent');
    await page.getByRole('button', { name: 'Check audience' }).click();
    await expect(page.getByRole('status').filter({ hasText: /will receive this/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Send to \d+/ }).or(page.getByText(/Not enough credits/))).toBeVisible();

    expect(errors).toEqual([]);
  });
});
