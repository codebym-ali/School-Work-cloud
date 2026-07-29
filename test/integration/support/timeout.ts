/**
 * Integration timeout budget.
 *
 * Every suite boots the whole AppModule (Nest DI + Prisma + Redis) in `beforeAll`. Jest's 5s
 * default is not a realistic budget for that: it only ever passed because ts-jest's cache
 * happened to be warm, and a cold run (fresh clone, cleared .tsbuildinfo, CI) failed dozens of
 * specs with "Exceeded timeout of 5000 ms for a hook" — setup timeouts masquerading as product
 * failures.
 *
 * This lives here rather than as `testTimeout` in jest.config.js because a project-level
 * `testTimeout` is **silently ignored** — Jest logs "Unknown option" and keeps the 5s default.
 * Verified with a 7s probe spec: it timed out at 5000ms with the config option in place, and
 * passes with this file. `setupFiles` cannot be used either — it runs before the test framework
 * is installed, so `jest.setTimeout` is not defined yet. `setupFilesAfterEnv` is the one that works.
 */
jest.setTimeout(30_000);
