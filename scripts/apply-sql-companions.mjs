#!/usr/bin/env node
/**
 * Applies the raw-SQL companion migrations (prisma/sql/*.sql) that Prisma cannot
 * express: partial uniques, CHECKs, the trigram index, RLS policies, and grants
 * (blueprint §17.1). Run AFTER `prisma migrate deploy` / `prisma migrate dev`.
 *
 * Connects as the migration owner (MIGRATION_DATABASE_URL) because ENABLE/FORCE
 * RLS and GRANT require table ownership. Each file is sent as one simple query,
 * so multi-statement scripts and DO blocks execute intact and idempotently.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sqlDir = join(__dirname, '..', 'prisma', 'sql');

const connectionString =
  process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('MIGRATION_DATABASE_URL (or DATABASE_URL) must be set.');
  process.exit(1);
}

const files = readdirSync(sqlDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const client = new pg.Client({ connectionString });

try {
  await client.connect();
  for (const file of files) {
    const sql = readFileSync(join(sqlDir, file), 'utf8');
    process.stdout.write(`  applying ${file} ... `);
    await client.query(sql);
    console.log('ok');
  }
  console.log(`\n✔ Applied ${files.length} SQL companion migration(s).`);
} catch (err) {
  console.error(`\n✖ Failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
