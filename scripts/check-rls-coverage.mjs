#!/usr/bin/env node
/**
 * CI guard (blueprint §21.3): fails the build if any table carrying a `school_id`
 * column lacks the `tenant_isolation` RLS policy — the mechanism that makes it
 * impossible to ship a new tenant table unscoped. Runs against a migrated DB.
 */
import pg from 'pg';

const connectionString =
  process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('MIGRATION_DATABASE_URL (or DATABASE_URL) must be set.');
  process.exit(1);
}

const client = new pg.Client({ connectionString });

const query = `
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

try {
  await client.connect();
  const { rows } = await client.query(query);
  if (rows.length > 0) {
    console.error('✖ RLS coverage check FAILED. Tables with school_id but no tenant_isolation policy:');
    for (const r of rows) console.error(`   - ${r.table_name}`);
    console.error('\nRun `pnpm db:sql` (prisma/sql/05_rls.sql) or add the table to it.');
    process.exitCode = 1;
  } else {
    console.log('✔ RLS coverage: every school_id table has the tenant_isolation policy.');
  }
} catch (err) {
  console.error(`✖ Check failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
