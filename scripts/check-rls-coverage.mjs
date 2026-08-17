#!/usr/bin/env node
/**
 * CI guard (blueprint §21.3). Two checks, and the second exists because the first has a blind spot.
 *
 * 1. COVERAGE — every table carrying a `school_id` column has the `tenant_isolation` RLS policy.
 *    This is the mechanism that makes it impossible to ship a new tenant table unscoped.
 *
 * 2. ⚠️ ENROLMENT — no table in `public` lacks `school_id` unless it is on the allowlist below.
 *
 *    Check 1 starts from `WHERE column_name = 'school_id'`, so **a table without that column is
 *    never a candidate and passes green**. It detects a forgotten policy; it cannot detect a
 *    forgotten column. All three isolation layers share that same assumption — `05_rls.sql` loops
 *    the same condition, and the Prisma client extension merges `schoolId` into operations on
 *    models that have it — so a tenant table born without `school_id` defeats all of them at once
 *    and nothing says a word.
 *
 *    Found 2026-08-17 while auditing the bell-schedule plan, which had modelled a class↔schedule
 *    link as an *implicit* Prisma many-to-many. Prisma materialises those as a join table holding
 *    only `A`/`B` uuid columns — real tenant data, no `school_id`, no policy, green build. Every
 *    many-to-many in this schema is an explicit tenant-chained model precisely so this cannot
 *    happen; that convention was universal and undocumented, which is how a plan reached for the
 *    shorthand in the first place. This check is the documentation.
 */
import pg from 'pg';

const connectionString =
  process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('MIGRATION_DATABASE_URL (or DATABASE_URL) must be set.');
  process.exit(1);
}

/**
 * Tables that legitimately carry no `school_id`. Deliberately short and explicit — a new entry here
 * is a claim that a table holds no tenant data, and it should be hard to add without noticing.
 *
 *  - `schools`              the tenant itself; tenant resolution reads it before any context exists
 *  - `platform_users`       the vendor console (§24), cross-tenant by design, no RLS
 *  - `platform_refresh_tokens`  their sessions, same reason
 *  - `_prisma_migrations`   Prisma's own bookkeeping
 */
const NON_TENANT_TABLES = [
  'schools',
  'platform_users',
  'platform_refresh_tokens',
  '_prisma_migrations',
];

const client = new pg.Client({ connectionString });

const coverageQuery = `
  SELECT c.table_name
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name
  WHERE c.table_schema = 'public'
    AND c.column_name = 'school_id'
    AND t.table_type = 'BASE TABLE'
    AND c.table_name <> 'schools'
    AND NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public'
        AND p.tablename = c.table_name
        AND p.policyname = 'tenant_isolation'
    );
`;

const enrolmentQuery = `
  SELECT t.table_name
  FROM information_schema.tables t
  WHERE t.table_schema = 'public'
    AND t.table_type = 'BASE TABLE'
    AND NOT (t.table_name = ANY ($1))
    AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = t.table_schema
        AND c.table_name = t.table_name
        AND c.column_name = 'school_id'
    )
  ORDER BY t.table_name;
`;

try {
  await client.connect();

  const { rows: uncovered } = await client.query(coverageQuery);
  if (uncovered.length > 0) {
    console.error('✖ RLS coverage FAILED. Tables with school_id but no tenant_isolation policy:');
    for (const r of uncovered) console.error(`   - ${r.table_name}`);
    console.error('\nRun `pnpm db:sql` (prisma/sql/05_rls.sql) or add the table to it.');
    process.exitCode = 1;
  } else {
    console.log('✔ RLS coverage: every school_id table has the tenant_isolation policy.');
  }

  const { rows: unenrolled } = await client.query(enrolmentQuery, [NON_TENANT_TABLES]);
  if (unenrolled.length > 0) {
    console.error('\n✖ Tenant enrolment FAILED. Tables in public with NO school_id column:');
    for (const r of unenrolled) console.error(`   - ${r.table_name}`);
    console.error(
      '\nA table without school_id gets no RLS policy and no help from the Prisma extension —' +
        '\nit is invisible to the coverage check above, not exempt from it.' +
        '\n\nIf this came from a Prisma relation, you have written an IMPLICIT many-to-many' +
        '\n(`foo Foo[]` on both sides). Replace it with an explicit join model carrying schoolId' +
        '\nand composite (id, schoolId) FKs — see BellScheduleClass or SectionSubject.' +
        '\n\nIf the table genuinely holds no tenant data, add it to NON_TENANT_TABLES in this file.',
    );
    process.exitCode = 1;
  } else {
    console.log('✔ Tenant enrolment: every table in public carries school_id, or is allowlisted.');
  }
} catch (err) {
  console.error(`✖ Check failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
