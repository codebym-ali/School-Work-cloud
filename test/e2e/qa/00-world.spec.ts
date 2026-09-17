import { test, expect } from '@playwright/test';
import { signIn, world } from './qa-world';

test('QA world: every account signs in on its own door', async ({ browser }) => {
  for (const role of ['owner', 'campusAdmin', 'accountantA', 'accountantB', 'teacher'] as const) {
    const { context } = await signIn(browser, role);
    await context.close();
  }
  expect(world().students.paid.name).toBe('Ali Raza');
});
