-- Runs once on first container start (docker-entrypoint-initdb.d).
-- Creates the two least-privilege roles the app uses (blueprint §21.5) and
-- the extensions the schema depends on. In production (Coolify-managed Postgres)
-- run this once by hand against the fresh database.

-- Extensions ---------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- trigram name search (blueprint §17.1)

-- Roles --------------------------------------------------------------------
-- app_user: the request-path connection. NO BYPASSRLS — RLS is non-negotiable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_pw' NOBYPASSRLS;
  END IF;
END$$;

-- platform_admin: BYPASSRLS, read-mostly. Vendor console + cross-tenant jobs only.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'platform_admin') THEN
    CREATE ROLE platform_admin LOGIN PASSWORD 'platform_pw' BYPASSRLS;
  END IF;
END$$;

-- Privileges: both roles operate on the public schema. Table-level grants are
-- applied by the RLS companion migration after tables exist (scripts/apply-sql-companions).
GRANT CONNECT ON DATABASE school TO app_user, platform_admin;
GRANT USAGE ON SCHEMA public TO app_user, platform_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platform_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user, platform_admin;
