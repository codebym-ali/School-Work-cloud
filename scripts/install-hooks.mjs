#!/usr/bin/env node
/**
 * Install a pre-push hook that runs the static gates before anything reaches `main`.
 *
 * ⚠️ **Why this exists.** CI was red from the first commit and nothing enforced otherwise, so four
 * further defects rotted behind it unseen. A red build that carries no consequence carries no
 * information.
 *
 * ⚠️ **This is a seatbelt, not a lock**, and the difference matters:
 *  - it is bypassable (`git push --no-verify`), by design — a hook that cannot be skipped in an
 *    emergency gets uninstalled instead;
 *  - it only protects machines that ran this script;
 *  - it runs `pnpm verify` (lint, typechecks, unit), NOT the integration or isolation suites, which
 *    need Postgres, Redis and MinIO. `pnpm ci:local` is the full sequence.
 *
 * Real protection is branch protection on GitHub: required status checks, which no local hook can
 * substitute for. This is what you get until that exists.
 *
 *   pnpm hooks:install     # install
 *   pnpm hooks:install --uninstall
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HOOK = `#!/bin/sh
# Installed by scripts/install-hooks.mjs. Runs the STATIC gates only — see that file.
# Skip in an emergency with:  git push --no-verify
echo "pre-push: running pnpm verify (skip with --no-verify)"
if ! pnpm verify; then
  echo ""
  echo "✖ pre-push blocked: pnpm verify failed."
  echo "  Fix it, or push with --no-verify if you know why you are doing that."
  exit 1
fi
`;

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const hooksDir = join(root, '.git', 'hooks');
const path = join(hooksDir, 'pre-push');

if (process.argv.includes('--uninstall')) {
  rmSync(path, { force: true });
  console.log('✔ pre-push hook removed.');
  process.exit(0);
}

if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });
// Mode 0o755: git ignores a hook it cannot execute, and does so SILENTLY — an unexecutable hook
// looks exactly like no hook at all, which is the worst of both worlds.
writeFileSync(path, HOOK, { mode: 0o755 });

console.log('✔ pre-push hook installed at .git/hooks/pre-push');
console.log('  It runs `pnpm verify` before every push. Bypass once with `git push --no-verify`.');
console.log('  ⚠️ Local only, and bypassable. Branch protection on GitHub is the real control.');
