import { purgeTenant, type RawSqlClient } from '@database';

export type { RawSqlClient };

/**
 * Delete a test tenant and everything under it.
 *
 * Delegates to the production `purgeTenant` (`@database`) so the test teardown can NEVER drift from
 * the real SA7 hard-delete — the whole reason a single copy of the FK-graph walk exists. (A
 * hand-maintained `const tables = [...]` list rotted before: several omitted `smsTemplate`, the final
 * `school` delete hit a RESTRICT FK, and a `.catch(() => undefined)` swallowed it — 251 dead schools
 * accumulated that way.) `purgeTenant` derives the order from the live FK graph and fails loudly if
 * the school survives; still typed structurally so a bare `PrismaClient` (Playwright) can pass here.
 */
export async function destroyTenant(platform: RawSqlClient, schoolId: string): Promise<void> {
  await purgeTenant(platform, schoolId);
}
