#!/usr/bin/env node
/**
 * Regenerate the Prisma client, even when the dev servers are holding it open.
 *
 * ⚠️ **Why this exists.** On Windows the API and worker keep
 * `node_modules/.prisma/client/query_engine-windows.dll.node` open, so `prisma generate` fails with
 *
 *     EPERM: operation not permitted, rename '…query_engine-windows.dll.node.tmp12345' -> '…'
 *
 * and the misleading part is what happens next: the OLD client stays loaded, so the first request
 * touching a new column returns a **500 at runtime** rather than anything pointing at generation.
 * That cost a confused ten minutes on 2026-09-15 and will recur on every schema change.
 *
 * ⚠️ **Tries first, stops nothing unless it has to.** On POSIX, and on Windows when the servers are
 * down, generation just works — killing processes unconditionally would be a cure worse than the
 * disease. Processes are only stopped when the lock actually bites.
 *
 * It deliberately does NOT restart them. A dev server belongs in the terminal where its owner can
 * read its logs; respawning it detached would hide exactly the output someone is about to need.
 *
 *   pnpm db:regen
 */
import { execFileSync, spawnSync } from 'node:child_process';

const WINDOWS = process.platform === 'win32';

/** Run `prisma generate`; return null on success, or the combined output on failure. */
function generate() {
  // ⚠️ One command STRING with `shell: true`, not a binary plus an args array.
  //
  // Passing args alongside `shell: true` triggers DEP0190 (they are concatenated unescaped), and
  // naming `npx.cmd` directly to avoid the shell fails too: modern Node refuses to spawn a .cmd
  // without one. A single string is the form that is neither deprecated nor blocked.
  const res = spawnSync('npx prisma generate', { encoding: 'utf8', shell: true });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}${res.error ? `
${res.error.message}` : ''}`;
  return res.status === 0 ? null : out;
}

/**
 * PIDs of the dev servers holding the engine.
 *
 * ⚠️ On POSIX the pattern is bracketed (`[a]pps`) so the search cannot match the shell running it.
 * `pgrep -f` reads FULL command lines, including its own `sh -c` wrapper — the same self-match that
 * once made the integration suite's worker guard report a phantom worker and block every CI run.
 */
function holders() {
  try {
    if (WINDOWS) {
      const ps =
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
        "Where-Object { $_.CommandLine -like '*apps*api*' -or $_.CommandLine -like '*apps*worker*' } | " +
        'Select-Object -ExpandProperty ProcessId';
      const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
      return out.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    }
    const out = execFileSync('sh', ['-c', "pgrep -f '[a]pps/(api|worker)/main' || true"], { encoding: 'utf8' });
    return out.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function stop(pids) {
  for (const pid of pids) {
    try {
      if (WINDOWS) execFileSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`]);
      else process.kill(Number(pid), 'SIGTERM');
    } catch {
      // A process that has already gone is the outcome we wanted.
    }
  }
}

const first = generate();
if (first === null) {
  console.log('✔ Prisma client regenerated.');
  process.exit(0);
}

// Only the file lock is worth stopping servers for. Any other failure — a schema error, a bad
// datasource — must be shown as-is, not buried under a restart dance that cannot fix it.
if (!/EPERM|EBUSY|resource busy|being used by another process/i.test(first)) {
  console.error(first.trim());
  console.error('\n✖ prisma generate failed, and not because of a file lock — see above.');
  process.exit(1);
}

const pids = holders();
if (pids.length === 0) {
  console.error(first.trim());
  console.error('\n✖ The client is locked, but no API or worker process was found holding it.');
  console.error('  Something else has the engine open — a stray node, an editor, or a test runner.');
  process.exit(1);
}

console.log(`The dev servers are holding the Prisma engine open. Stopping ${pids.length}: ${pids.join(', ')}`);
stop(pids);

const second = generate();
if (second !== null) {
  console.error(second.trim());
  console.error('\n✖ Still locked after stopping the dev servers.');
  process.exit(1);
}

console.log('✔ Prisma client regenerated.');
console.log('\n⚠️ The API and worker were stopped to release the lock. Start them again in their own');
console.log('   terminals, so their logs stay where you can read them:');
console.log('     pnpm start:api:dev');
console.log('     pnpm start:worker:dev');
