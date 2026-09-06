/**
 * ⚠️ **Deep import, deliberately — do not "tidy" this back to the `@database` barrel.**
 *
 * The barrel re-exports `database.module`, which pulls in `prisma.service` and its NestJS
 * **parameter decorator** (`constructor(@Inject(ENV) env: Env)`). Playwright's TypeScript loader
 * cannot parse those, so importing the barrel here made the e2e `globalTeardown` die with
 * `SyntaxError: Decorators cannot be used to decorate parameters` on **every run** — reported only
 * as "1 error was not a part of any test", which is easy to read past. The result was that the
 * cleanup written to stop test debris accumulating in the operator's demo tenant had silently
 * stopped running (the failure that once had the dashboard reporting 71 unmarked registers, 67 of
 * them ours).
 *
 * `tenant-purge.ts` has **no imports at all**, so naming it directly keeps the single shared copy of
 * the FK-graph walk — no duplication — while staying parseable outside Nest. ts-jest is unaffected.
 */
import { purgeTenant, type RawSqlClient } from '@database/tenant-purge';

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
