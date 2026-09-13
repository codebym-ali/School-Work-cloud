/**
 * Integration globalSetup: refuse to run while a worker is alive.
 *
 * `pnpm start:worker:dev` runs `nest start worker --watch`, and the watch parent RESPAWNS
 * `dist/apps/worker/main` after the child is killed — so a worker comes back without anyone
 * meaning it to. It then competes with the suites' manual `drainSms()` for the shared BullMQ
 * `sms` queue, producing either "Job … locked by another worker" or a duplicate SmsLog. The
 * symptom lands in attendance/exams/fees and looks like a product bug.
 *
 * This is documented in Key Decisions, but documentation did not stop it happening twice in
 * one day — so it is enforced here instead. Fail fast, name the process, exit.
 */
const { execSync } = require('node:child_process');

/** PIDs of any live `dist/apps/worker/main`, or [] when none / the listing is unavailable. */
function findWorkerPids() {
  let out = '';
  try {
    out =
      process.platform === 'win32'
        ? execSync(
            'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Where-Object { $_.CommandLine -like \'*apps?worker*\' -or $_.CommandLine -like \'*apps/worker*\' -or $_.CommandLine -like \'*apps\\\\worker*\' } | Select-Object -ExpandProperty ProcessId"',
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
          )
        : // ⚠️ `[a]pps` is NOT a typo — it is the fix for a self-match that made this guard block
          // every CI run of the integration suite.
          //
          // `execSync` runs the command through `sh -c`, and `pgrep -f` matches against FULL command
          // lines — including that shell's own, which literally contains the pattern. So the guard
          // found itself, reported a phantom worker PID, and aborted globalSetup. It never showed up
          // locally because Windows takes the PowerShell branch above; this branch only ever ran in
          // CI, where the integration step had never got this far.
          //
          // The bracket makes the REGEX still match "apps/worker/main" while the literal text on the
          // shell's command line reads "[a]pps/...", which the regex does not match. A real worker is
          // still found; the guard no longer finds itself.
          execSync("pgrep -f '[a]pps/worker/main' || true", { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return []; // process listing unavailable — don't block the run over it
  }
  return out.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Throw if a worker is alive.
 *
 * Called from BOTH `globalSetup` (before the run) and `beforeAll` of every spec file, because a
 * startup-only check cannot see a worker that respawns MID-RUN — which is exactly what
 * `nest start worker --watch` does. That gap produced several confusing failures ("Job … locked
 * by another worker") inside whichever spec happened to be running at the time, in fees,
 * attendance and exams on different days, each of which looked like a product bug and had to be
 * disproved by re-running the spec alone.
 *
 * Per-file granularity is the practical limit: it cannot stop a worker appearing mid-file, but
 * it names the real cause at the next boundary instead of leaving a stray assertion failure.
 */
function assertNoWorker() {
  const pids = findWorkerPids();
  if (pids.length === 0) return;

  throw new Error(
    [
      '',
      '  A worker process is running — the integration suite cannot share the BullMQ "sms" queue with it.',
      `  PID(s): ${pids.join(', ')}`,
      '',
      '  Stop it first (the --watch parent respawns the child, so kill the tree):',
      '    Windows:  taskkill /PID <pid> /T /F',
      '    POSIX:    pkill -f apps/worker/main',
      '',
    ].join('\n'),
  );
}

module.exports = assertNoWorker;
module.exports.assertNoWorker = assertNoWorker;
module.exports.findWorkerPids = findWorkerPids;
