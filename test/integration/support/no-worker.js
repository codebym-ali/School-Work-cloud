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

module.exports = async function assertNoWorker() {
  let out = '';
  try {
    out =
      process.platform === 'win32'
        ? execSync(
            'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Where-Object { $_.CommandLine -like \'*apps?worker*\' -or $_.CommandLine -like \'*apps/worker*\' -or $_.CommandLine -like \'*apps\\\\worker*\' } | Select-Object -ExpandProperty ProcessId"',
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
          )
        : execSync("pgrep -f 'apps/worker/main' || true", { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return; // process listing unavailable — don't block the run over it
  }

  const pids = out.split(/\s+/).map((s) => s.trim()).filter(Boolean);
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
};
