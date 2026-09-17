import { test, expect, type Page } from '@playwright/test';
import { api, signIn, world } from './qa-world';

/** ACT, REP, DEF, CMP, SET — the owner's read screens (Phase 4). */

/** Make sure one reasoned, owner-made correction exists (03-fees makes it; this keeps the file standalone). */
async function ensureReversal(page: Page): Promise<string> {
  const w = world();
  const reason = 'QA FEE-02: posted against the wrong student';
  const log = await api<{ data: Array<{ reason: string | null }> }>(page, 'GET', '/audit-logs?action=PAYMENT_REVERSED&limit=20');
  if (log.body.data?.some((r) => r.reason === reason)) return reason;
  const invoices = await api<{ data: Array<{ id: string }> }>(page, 'GET', `/fees/invoices?studentId=${w.students.paid.id}`);
  for (const inv of invoices.body.data) {
    const detail = await api<{ payments: Array<{ id: string; amountPaid: string }> }>(page, 'GET', `/fees/invoices/${inv.id}`);
    for (const p of detail.body.payments ?? []) {
      if (Number(p.amountPaid) <= 0) continue;
      const res = await api(page, 'POST', `/fees/payments/${p.id}/reversals`, { reason });
      if (res.status < 300) return reason;
    }
  }
  return reason;
}

test.describe('ACT · activity log', () => {
  test('ACT-01 a correction shows who made it and why; ACT-02 filtering by action narrows the list', async ({ browser }) => {
    const { page, context } = await signIn(browser, 'owner');
    const reason = await ensureReversal(page);
    await page.goto('/activity');
    await expect(page.getByRole('heading', { name: 'Activity log' })).toBeVisible();
    const row = page.locator('tbody tr', { hasText: reason }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText('owner@qa.pk');

    await page.locator('#act-action').fill('PAYMENT_REVERSED');
    // The list refetches after typing; poll until what is shown is only reversals.
    await expect.poll(async () => {
      const whats = await page.locator('tbody tr td:nth-child(3)').evaluateAll((tds) => tds.map((td) => td.getAttribute('title')));
      return whats.length > 0 && whats.every((a) => a === 'PAYMENT_REVERSED');
    }, { message: 'ACT-02: only reversals listed' }).toBe(true);
    await expect(page.locator('tbody tr').first()).toContainText(reason);
    await context.close();
  });

  test("ACT-03 a campus admin does not see the owner's entries", async ({ browser }) => {
    const owner = await signIn(browser, 'owner');
    const reason = await ensureReversal(owner.page);
    await owner.context.close();

    const { page, context } = await signIn(browser, 'campusAdmin');
    await page.goto('/activity');
    await expect(page.getByText('Campus admins see activity by people on their own campus.')).toBeVisible();
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await expect(page.getByText('Loading…')).toHaveCount(0);
    await expect(page.locator('tbody')).not.toContainText(reason);
    await expect(page.locator('tbody')).not.toContainText('owner@qa.pk');
    await context.close();
  });
});

test.describe('REP · reports', () => {
  test('REP-02 a required choice blocks View and says what is missing; REP-03 students are found by name', async ({ browser }) => {
    const w = world();
    const { page, context } = await signIn(browser, 'owner');
    await page.goto('/reports');
    await page.locator('#rep-key').selectOption('fee-ledger');
    await expect(page.getByRole('button', { name: 'View' })).toBeDisabled();
    await expect(page.getByText('Choose a student first.')).toBeVisible();

    await page.locator('#rep-student').pressSequentially(w.students.owingWaive.name.slice(0, 4));
    const option = page.locator('#rep-student-list').getByRole('option', { name: new RegExp(w.students.owingWaive.name) });
    await expect(option).toBeVisible();
    await expect(option).toContainText('QA One');
    await option.click();
    await expect(page.getByRole('button', { name: 'View' })).toBeEnabled();
    await page.getByRole('button', { name: 'View' }).click();
    await expect(page.locator('table')).toBeVisible();
    await context.close();
  });

  test('REP-01 every report runs from pickers, with no id typed', async ({ browser }) => {
    const { page, context } = await signIn(browser, 'owner');
    await page.goto('/reports');
    await expect(page.locator('#rep-key option').nth(6)).toBeAttached();
    const keys = await page.locator('#rep-key option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(keys.length).toBeGreaterThanOrEqual(7);
    for (const key of keys) {
      await page.locator('#rep-key').selectOption(key);
      await expect(page.locator('label', { hasText: /Id\b/ })).toHaveCount(0);
      if (key === 'fee-ledger') {
        await page.locator('#rep-student').pressSequentially('Sara');
        await page.locator('#rep-student-list').getByRole('option').first().click();
      }
      for (const id of ['#rep-section', '#rep-exam']) {
        const s = page.locator(id);
        if (await s.count()) {
          const n = await s.locator('option').count();
          if (n < 2) { test.info().annotations.push({ type: 'note', description: `${key}: no ${id} to choose in the QA school` }); continue; }
          await s.selectOption({ index: 1 });
        }
      }
      const view = page.getByRole('button', { name: 'View' });
      if (!(await view.isEnabled())) continue; // exam-summary with no exam in this school — noted above
      const res = page.waitForResponse((r) => r.url().includes(`/reports/${key}`) && r.request().method() === 'GET');
      await view.click();
      expect((await res).status(), key).toBe(200);
      await expect(page.locator('table').or(page.getByText('Nothing to report for these choices.'))).toBeVisible();
    }
    await context.close();
  });
});

test.describe('DEF · defaulters', () => {
  test('DEF-01 the working list names who to contact and whether SMS can reach them', async ({ browser }) => {
    const w = world();
    const { page, context } = await signIn(browser, 'owner');
    await page.goto('/defaulters');
    await expect(page.getByRole('heading', { name: 'Defaulters' })).toBeVisible();
    const campusB = page.locator('tbody tr', { hasText: w.students.campusB.name });
    await expect(campusB).toBeVisible();
    await expect(campusB).toContainText('Rs 3,000');
    await expect(campusB.getByRole('checkbox')).toBeEnabled(); // verified guardian → textable
    await context.close();
  });

  test("DEF-02 a campus admin sees only their campus's defaulters", async ({ browser }) => {
    const w = world();
    { const o = await signIn(browser, 'owner'); await ensureReversal(o.page); await o.context.close(); }
    const { page, context } = await signIn(browser, 'campusAdmin');
    await page.goto('/defaulters');
    await expect(page.getByRole('heading', { name: 'Defaulters' })).toBeVisible();
    // Wait for the list itself, so an absence is not just a page still loading. Ali (campus A, reversal re-opened his
    // July balance) must be there; Bilal (campus B) must not.
    await expect(page.locator('tbody tr', { hasText: w.students.paid.name })).toBeVisible();
    await expect(page.locator('tbody')).not.toContainText(w.students.campusB.name);
    await context.close();
  });

  test('DEF-03 the dashboard Defaulters tile leads to the working list', async ({ browser }) => {
    const { page, context } = await signIn(browser, 'owner');
    await page.goto('/dashboard');
    await page.getByRole('link', { name: /Defaulters/ }).first().click();
    await page.waitForURL('**/defaulters');
    await context.close();
  });
});

test.describe('CMP · SET', () => {
  test('CMP-01 Campus Hub compares both campuses', async ({ browser }) => {
    const w = world();
    const { page, context } = await signIn(browser, 'owner');
    await page.goto('/campuses');
    const cmp = page.locator('.card', { hasText: 'How the campuses compare' });
    await expect(cmp).toBeVisible();
    await expect(cmp).toContainText(w.campusA.name);
    await expect(cmp).toContainText(w.campusB.name);
    await context.close();
  });

  test('SET-01 fees are setup step 4 and name the unpriced class', async ({ browser }) => {
    const { page, context } = await signIn(browser, 'owner');
    await page.goto('/setup');
    const step = page.locator('.card', { has: page.getByRole('heading', { name: 'Fees', level: 2, exact: true }) });
    await expect(step).toBeVisible();
    await expect(step).toContainText('2 of 3 classes priced');
    if (!(await step.getByText(/no fee for this year/).count())) await step.getByRole('heading', { name: 'Fees' }).click();
    await expect(step.getByText(/no fee for this year/)).toContainText('QA Two');
    await context.close();
  });
});
