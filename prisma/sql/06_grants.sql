-- Companion migration 06: table/sequence grants (blueprint §21.5).
-- Tables are owned by the migration superuser. The runtime roles get DML only —
-- never ownership, never BYPASSRLS (app_user), so RLS (FORCE'd) always applies.

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user, platform_admin;

-- Keep future tables (later migrations) grantable without re-running this by hand.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user, platform_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user, platform_admin;

-- ⚠️ **The blanket GRANT above reaches EVERY table in `public` — including the vendor-side ones —
-- and this file runs AFTER `prisma migrate deploy`. So it silently undid the REVOKEs those
-- migrations perform: the SA0 migration revokes the operator tables from app_user, and thirty
-- seconds later `pnpm db:sql` handed them straight back.** Measured on a live dev database:
-- app_user could SELECT platform_users, platform_audit_logs and platform_mfa_recovery_codes.
--
-- These four tables carry no `school_id`, so **RLS does not apply to them at all** (they are the
-- NON_TENANT allowlist in `check-rls-coverage.mjs`). Grants are therefore the ONLY access control
-- standing between the tenant runtime role and operator emails, argon2 password hashes, encrypted
-- MFA secrets, recovery-code hashes and the whole vendor audit trail — and it was wide open.
--
-- The revoke belongs HERE, at the end of the last file `db:setup` runs, not in a migration: a
-- migration runs once, this runs every time, and whatever runs last wins. `schools` is
-- deliberately NOT in this list — it has no school_id either, but tenant resolution must read it.
REVOKE ALL PRIVILEGES ON TABLE
  platform_users,
  platform_refresh_tokens,
  platform_audit_logs,
  platform_mfa_recovery_codes,
  platform_stats
FROM app_user;

-- Future vendor tables must not be re-granted by the ALTER DEFAULT PRIVILEGES above either; the
-- companion is re-applied on every `db:setup`, so adding the new table to the list is the fix.
