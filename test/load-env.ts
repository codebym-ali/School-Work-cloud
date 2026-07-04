import 'reflect-metadata';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Jest setupFile: load .env into process.env (jest doesn't honour node --env-file),
 * then ensure reflect-metadata is available for Nest DI in tests.
 */
const envPath = join(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const quoted =
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      // Strip an unquoted inline comment (" # ..."). JSON values are unquoted here
      // but contain no '#', so this is safe.
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
