#!/usr/bin/env node
/**
 * CI guard: no Prisma migration may DROP an object that a SQL companion owns.
 *
 * Why this exists — `prisma migrate diff` cannot see `prisma/sql/*.sql`. Those companions create
 * everything Prisma's schema language can't express (partial uniques, CHECKs, RLS policies, the
 * trigram index). Because the generated diff has no knowledge of them, it believes they are
 * drift and emits a DROP.
 *
 * In this repo it has tried to `DROP INDEX students_full_name_trgm` **six separate times**. Each
 * one was caught by reading the generated SQL by hand — and taking any single one of them would
 * have silently killed student name search, with no error and no failing test, because nothing
 * else depends on that index existing. A guard turns six lucky catches into a structural rule.
 *
 * The list of protected objects is DERIVED from the companions rather than hardcoded, so a
 * companion added tomorrow is covered without anyone remembering to update this file.
 *
 * Deliberately NOT a database check: this reads the committed SQL, so it fails in review — before
 * the DROP is ever applied to anything.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SQL_DIR = 'prisma/sql';
const MIGRATIONS_DIR = 'prisma/migrations';

/** Objects the companions create: `CREATE [UNIQUE] INDEX [IF NOT EXISTS] name`, `CREATE POLICY name`. */
function protectedObjects() {
  const owners = new Map(); // name -> companion file that creates it
  for (const file of readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(join(SQL_DIR, file), 'utf8');
    const patterns = [
      /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?/gi,
      /create\s+policy\s+"?([a-z0-9_]+)"?/gi,
    ];
    for (const re of patterns) {
      for (const m of sql.matchAll(re)) owners.set(m[1].toLowerCase(), file);
    }
  }
  return owners;
}

/** Every committed migration.sql, newest last. */
function migrationFiles() {
  let dirs = [];
  try {
    dirs = readdirSync(MIGRATIONS_DIR).filter((d) => statSync(join(MIGRATIONS_DIR, d)).isDirectory());
  } catch {
    return [];
  }
  return dirs
    .sort()
    .map((d) => join(MIGRATIONS_DIR, d, 'migration.sql'))
    .filter((p) => {
      try { return statSync(p).isFile(); } catch { return false; }
    });
}

const owners = protectedObjects();
if (owners.size === 0) {
  console.error(`✖ No protected objects found in ${SQL_DIR} — the guard would pass vacuously.`);
  process.exit(1);
}

const violations = [];
for (const file of migrationFiles()) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    // Ignore comments — the migrations in this repo explain these objects in prose, and a
    // sentence mentioning a DROP must not fail the build.
    const code = line.replace(/--.*$/, '');
    if (!/\bdrop\b/i.test(code)) return;
    for (const [name, companion] of owners) {
      // Word-boundary match so `students_full_name_trgm_old` doesn't trip on the real name.
      if (new RegExp(`(^|[^a-z0-9_])${name}([^a-z0-9_]|$)`, 'i').test(code)) {
        violations.push({ file, line: i + 1, name, companion, text: line.trim() });
      }
    }
  });
}

if (violations.length) {
  console.error('✖ A migration drops an object owned by a SQL companion.\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text}`);
    console.error(`    "${v.name}" is created by ${SQL_DIR}/${v.companion}\n`);
  }
  console.error('`prisma migrate diff` cannot see prisma/sql/*.sql, so it reports those objects as');
  console.error('drift and emits a DROP. Curate the generated migration: delete the DROP and keep');
  console.error('only the changes you intended. Applying it would silently remove the object.');
  process.exit(1);
}

console.log(`✔ Migration safety: no migration drops any of the ${owners.size} SQL-companion objects.`);
