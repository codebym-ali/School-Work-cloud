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

/**
 * Warn — loudly, once per spec file — if a worker appears DURING the run.
 *
 * `globalSetup` is the hard gate and still aborts the run when a worker is up at the start. It
 * cannot see one that respawns mid-run, though, and `nest start worker --watch` does exactly
 * that; the result was a stray "Job … locked by another worker" inside whichever suite happened
 * to be unlucky, which reads as a product bug and costs a re-run to disprove.
 *
 * This deliberately WARNS rather than throws. Throwing was tried first and made things strictly
 * worse: a worker appearing early in a run failed every remaining file's `beforeAll`, turning
 * one environment problem into 470 red tests and burying the very cause it existed to reveal.
 * A banner immediately above the real failure diagnoses it without amplifying it.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { findWorkerPids } = require('./no-worker.js') as { findWorkerPids: () => string[] };

beforeAll(() => {
  const pids = findWorkerPids();
  if (!pids.length) return;
  console.error(
    [
      '',
      `  ⚠ A worker process (PID ${pids.join(', ')}) started DURING this run.`,
      '    It shares the BullMQ "sms" queue with these specs, so an SMS assertion below may fail',
      '    with "locked by another worker" or a duplicate SmsLog. That is the environment, not',
      '    the product. Stop it and re-run — kill the --watch parent, not just the child:',
      '      taskkill /PID <pid> /T /F',
      '',
    ].join('\n'),
  );
});
