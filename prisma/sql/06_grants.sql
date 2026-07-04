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
