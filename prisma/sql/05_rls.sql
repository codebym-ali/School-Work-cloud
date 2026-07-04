-- Companion migration 05: Row-Level Security (blueprint §21.3, §21.6).
-- Applies ENABLE + FORCE RLS and the tenant_isolation policy to EVERY table that
-- carries a school_id column, except `schools` itself (tenant resolution needs it;
-- it holds no child data). Auto-covering every school_id table is exactly the
-- "generated migration" approach the blueprint mandates — a new tenant table is
-- protected the moment it exists, and the CI grep (scripts/check-rls-coverage.mjs)
-- fails the build if any school_id table is left without a policy.
--
-- Fail-closed behaviour: current_setting('app.current_school_id', true) returns
-- NULL when the GUC was never set — BUT once the GUC has been set on a connection
-- and then reset (which happens on every pooled connection between requests, since
-- withTenant sets it transaction-locally), Postgres returns an EMPTY STRING, and
-- ''::uuid raises 22P02 instead of matching zero rows. So we wrap it in
-- NULLIF(..., '') => empty string collapses to NULL => policy matches zero rows.
-- This is a hardening over the blueprint's literal SQL and is asserted by the
-- tenant-isolation suite (no-context read must return 0 rows, never error).

DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'school_id'
      AND t.table_type = 'BASE TABLE'
      AND c.table_name <> 'schools'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL '
      || 'USING (school_id = NULLIF(current_setting(''app.current_school_id'', true), '''')::uuid) '
      || 'WITH CHECK (school_id = NULLIF(current_setting(''app.current_school_id'', true), '''')::uuid);',
      tbl
    );
  END LOOP;
END$$;
