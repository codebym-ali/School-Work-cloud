import { test, expect } from '@playwright/test';
import { api, signIn, world } from './qa-world';

/**
 * SMS-01..05 — broadcast by audience and opt-out (Phase 6.1 + item 9).
 *
 * Needs the SMS worker running (it dispatches the queue and writes the log). The QA school's families: Ali, Omar,
 * Hamza and Bilal have verified numbers; Sara's is unverified; Zoya's parent is verified but opted out.
 */
test.describe('SMS · broadcast and opt-out', () => {
  test('SMS-01 the audience is counted, with reasons, before anything is sent; SMS-02 editing the message resets it', async ({ browser }) => {
    const { page, context } = await signIn(browser, 'owner');
    await page.goto('/sms');
    await page.locator('#bc-body').fill('QA SMS-01: School closed tomorrow.');
    await page.getByRole('button', { name: 'Check audience' }).click();
    const status = page.getByRole('status').filter({ hasText: /will receive this/ });
    await expect(status).toBeVisible();
    await expect(status).toContainText(/credits of [\d,]+ available/);
    await expect(status).toContainText('opted out of SMS');
    await expect(status).toContainText('unverified number');
    await expect(page.getByRole('button', { name: /^Send to \d+ famil/ })).toBeVisible();

    await page.locator('#bc-body').fill('QA SMS-02: changed wording');
    await expect(page.getByRole('button', { name: 'Check audience' }), 'SMS-02').toBeVisible();
    await expect(status).toHaveCount(0);
    await context.close();
  });

  test('SMS-03 sending is two steps and lands in Sent messages', async ({ browser }) => {
    const { page, context } = await signIn(browser, 'owner');
    await page.goto('/sms');
    const body = `QA SMS-03 broadcast ${Date.now()}`;
    await page.locator('#bc-body').fill(body);
    await page.getByRole('button', { name: 'Check audience' }).click();
    const send = page.getByRole('button', { name: /^Send to (\d+) famil/ });
    const families = Number((await send.innerText()).match(/\d+/)![0]);
    await send.click();
    await expect(page.getByText('Messages cannot be recalled once sent.')).toBeVisible();
    await page.getByRole('button', { name: 'Yes, send now' }).click();
    await expect(page.locator('.toast.ok', { hasText: new RegExp(`Queued to ${families} famil`) })).toBeVisible();

    // The worker dispatches; the log shows one row per family with this body.
    await expect.poll(async () => {
      await Promise.all([page.waitForResponse((r) => r.url().includes('/sms/logs')), page.reload()]);
      await page.waitForTimeout(300);
      return page.locator('tbody tr', { hasText: body }).count();
    }, { timeout: 30_000, message: 'broadcast rows appear in Sent messages' }).toBe(families);
    await context.close();
  });

  test('SMS-04 an opted-out parent is withheld, said so in words, and offers no Retry', async ({ browser }) => {
    const w = world();
    const { page, context } = await signIn(browser, 'owner');
    // A hand-typed send is the path that bypassed opt-out before item 9. It has no screen, so it is sent directly.
    const res = await api(page, 'POST', '/sms/send', { recipients: [w.phones.optedOut], body: 'QA SMS-04 should be withheld' });
    expect(res.status).toBeLessThan(300);
    await page.goto('/sms');
    const row = page.locator('tbody tr', { hasText: 'Parent opted out of SMS' }).first();
    await expect.poll(async () => {
      await Promise.all([page.waitForResponse((r) => r.url().includes('/sms/logs')), page.reload()]);
      await page.waitForTimeout(300);
      return row.count();
    }, { timeout: 30_000, message: 'withheld row logged' }).toBeGreaterThan(0);
    await expect(row).toContainText('(withheld: opted out of SMS)');
    await expect(row.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await context.close();
  });

  test('SMS-05 a campus admin reaches only their own campus', async ({ browser }) => {
    const owner = await signIn(browser, 'owner');
    await owner.page.goto('/sms');
    await owner.page.locator('#bc-body').fill('QA SMS-05');
    await owner.page.getByRole('button', { name: 'Check audience' }).click();
    const ownerStudents = Number((await owner.page.getByRole('status').filter({ hasText: /will receive this/ }).innerText()).match(/\((\d+) students\)/)![1]);
    await owner.context.close();

    const { page, context } = await signIn(browser, 'campusAdmin');
    await page.goto('/sms');
    await expect(page.locator('#bc-campus')).toHaveCount(0);
    await page.locator('#bc-body').fill('QA SMS-05');
    await page.getByRole('button', { name: 'Check audience' }).click();
    const text = await page.getByRole('status').filter({ hasText: /will receive this/ }).innerText();
    const adminStudents = Number(text.match(/\((\d+) students?\)/)![1]);
    expect(adminStudents, 'campus B student excluded').toBe(ownerStudents - 1);
    await context.close();
  });
});
