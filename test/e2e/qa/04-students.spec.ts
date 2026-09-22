import { test, expect, type Page } from '@playwright/test';
import { api, signIn, world } from './qa-world';

const card = (page: Page, heading: string) => page.locator('.card', { has: page.getByRole('heading', { name: heading, exact: true }) });

/** GUA-01..04, WDR-01..04 — guardians and withdrawal on the student profile (Phase 3.1–3.2). */
test.describe('GUA · guardians', () => {
  const second = `QA Uncle ${Date.now().toString().slice(-4)}`;

  test('GUA-01 add a second guardian; it is marked unverified', async ({ browser }) => {
    const w = world();
    const { page, context } = await signIn(browser, 'owner');
    await page.goto(`/students?student=${w.students.paid.id}`);
    const g = card(page, 'Guardians');
    await g.getByRole('button', { name: '+ Add guardian' }).click();
    await page.locator('#ng-name').fill(second);
    await page.locator('#ng-phone').fill(`0321${Date.now().toString().slice(-7)}`);
    const rel = page.locator('#ng-rel');
    if (await rel.evaluate((el) => el.tagName === 'SELECT')) await rel.selectOption({ index: 1 });
    else await rel.fill('Uncle');
    await g.getByRole('button', { name: 'Add guardian', exact: true }).click();
    const row = g.locator('.stack', { has: page.getByText(second, { exact: true }) }).last();
    await expect(row).toBeVisible();
    await expect(row.getByText('not verified — no SMS')).toBeVisible();
    await context.close();
  });

  test('GUA-02 the primary guardian offers no Remove; GUA-03 another can be made primary', async ({ browser }) => {
    const w = world();
    const { page, context } = await signIn(browser, 'owner');
    await page.goto(`/students?student=${w.students.paid.id}`);
    const g = card(page, 'Guardians');
    const primaryRow = g.locator('.stack', { has: page.locator('.badge', { hasText: /^primary$/ }) }).last();
    await expect(primaryRow).toBeVisible();
    await expect(primaryRow.getByRole('button', { name: 'Remove' }), 'GUA-02').toHaveCount(0);

    const secondRow = g.locator('.stack', { has: page.getByText(second, { exact: true }) }).last();
    await secondRow.getByRole('button', { name: 'Make primary' }).click();
    await page.getByRole('button', { name: 'Make primary' }).last().click();
    await expect(secondRow.locator('.badge', { hasText: /^primary$/ })).toBeVisible();
    await context.close();
  });

  test('GUA-04 a non-primary guardian can be removed', async ({ browser }) => {
    const w = world();
    const { page, context } = await signIn(browser, 'owner');
    await page.goto(`/students?student=${w.students.paid.id}`);
    const g = card(page, 'Guardians');
    // The original mother is now the non-primary one.
    const nonPrimary = g.locator('.stack', { has: page.getByRole('button', { name: 'Remove' }) }).last();
    const name = (await nonPrimary.locator('strong').first().innerText()).trim();
    await nonPrimary.getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('button', { name: 'Remove guardian' }).click();
    await expect(g.getByText(name, { exact: true })).toHaveCount(0);
    await context.close();
  });
});

test.describe('WDR · withdrawal', () => {
  test('WDR-04 a campus admin cannot let an owing student leave', async ({ browser }) => {
    const w = world();
    const { page, context } = await signIn(browser, 'campusAdmin');
    await page.goto(`/students?student=${w.students.owingWithdraw.id}`);
    await card(page, 'Leaving the school').getByRole('button', { name: 'Withdraw student' }).click();
    await expect(page.getByText(/is still owed/).first()).toBeVisible();
    await expect(page.getByText('only the owner can let a student leave owing money')).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('checkbox')).toHaveCount(0);
    await page.locator('#reasoned-action-reason').fill('QA WDR-04');
    await expect(page.getByRole('button', { name: 'Withdraw student' }).last()).toBeDisabled();
    await context.close();
  });

  test('WDR-01 withdraw a student with no dues', async ({ browser }) => {
    const w = world();
    const { page, context } = await signIn(browser, 'owner');
    await page.goto(`/students?student=${w.students.noDues.id}`);
    await card(page, 'Leaving the school').getByRole('button', { name: 'Withdraw student' }).click();
    await expect(page.getByText('Nothing is owed.')).toBeVisible();
    await page.locator('#reasoned-action-reason').fill('QA WDR-01: family relocating');
    await page.getByRole('button', { name: 'Withdraw student' }).last().click();
    // ⚠️ QA-D2: the profile reloads as withdrawn and unmounts the dialog, so the result message is gone within
    // moments — sometimes before it can be read at all. Asserted by the outcome: the student is withdrawn.
    await expect(page.getByText('This student has been withdrawn.')).toBeVisible();
    await context.close();
  });

  test('WDR-02 the owner may let an owing student leave; the balance is not waived', async ({ browser }) => {
    const w = world();
    const { page, context } = await signIn(browser, 'owner');
    await page.goto(`/students?student=${w.students.owingWithdraw.id}`);
    await card(page, 'Leaving the school').getByRole('button', { name: 'Withdraw student' }).click();
    await expect(page.getByText(/is still owed/).first()).toBeVisible();
    await page.locator('#reasoned-action-reason').fill('QA WDR-02: left owing, owner approved');
    const confirm = page.getByRole('button', { name: 'Withdraw student' }).last();
    await expect(confirm, 'blocked until the owner ticks the override').toBeDisabled();
    await expect(page.getByText('this is not a waiver', { exact: false })).toBeVisible();
    await page.getByRole('dialog').getByRole('checkbox').check();
    await confirm.click();
    // QA-D2 again: the result message is unmounted with the dialog. The outcome is what matters — withdrawn, and the
    // July balance still owed rather than quietly waived.
    await expect(page.getByText('This student has been withdrawn.')).toBeVisible();
    const inv = await api<{ data: Array<{ month: number; status: string }> }>(page, 'GET', `/fees/invoices?studentId=${w.students.owingWithdraw.id}`);
    expect(inv.body.data.find((i) => i.month === 7)?.status).not.toBe('WAIVED');
    await context.close();
  });

});
