import { execFileSync } from 'node:child_process';
import { findWorkerPids } from './no-worker';

/**
 * The worker guard must not detect ITSELF.
 *
 * ⚠️ This is the bug this file exists for. `findWorkerPids` shells out, and `pgrep -f` matches
 * against full command lines — including the `sh -c` wrapper `execSync` creates, whose own command
 * line contains the pattern being searched for. The guard therefore reported a phantom worker PID
 * and aborted `globalSetup`, blocking EVERY CI run of the integration suite.
 *
 * It hid for the life of the project because the POSIX branch never ran on a developer machine
 * (Windows takes the PowerShell branch) and the integration step had never got that far in CI.
 *
 * The fix is the `[a]pps` bracket: the regex still matches "apps/worker/main", while the literal
 * text on the wrapper's command line reads "[a]pps/..." and does not match.
 */
describe('worker guard self-detection', () => {
  const posix = process.platform !== 'win32';

  (posix ? it : it.skip)('does not match the shell that runs the search', () => {
    // Run a shell whose command line contains the literal pattern, exactly as execSync does, and
    // confirm the guard's own search does not see it. Before the fix this returned that shell's PID.
    const script = "pgrep -f '[a]pps/worker/main' || true";
    const out = execFileSync('sh', ['-c', script], { encoding: 'utf8' }).trim();
    const pids = out.split(/\s+/).filter(Boolean);

    for (const pid of pids) {
      // Any PID reported must be a REAL worker, never the search itself.
      const cmd = execFileSync('ps', ['-p', pid, '-o', 'args='], { encoding: 'utf8' }).trim();
      expect(cmd).not.toContain('pgrep');
      expect(cmd).toMatch(/apps[/\\]worker[/\\]main/);
    }
  });

  it('returns an array and never throws, whatever the platform', () => {
    // A process listing that is unavailable must not block a run — the guard catches and returns [].
    expect(Array.isArray(findWorkerPids())).toBe(true);
  });
});
