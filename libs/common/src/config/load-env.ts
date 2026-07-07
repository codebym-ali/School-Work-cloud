import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Load a local `.env` into process.env if present, so `nest start` (dev) works without
 * `node --env-file`. In production there is no `.env` file — env vars are injected by
 * Coolify — so this is a no-op there. Existing process.env values always win.
 */
export function loadDotenv(path = join(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in process.env) continue;
    let value = trimmed.slice(eq + 1).trim();
    const quoted =
      (value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }
    process.env[key] = value;
  }
}
