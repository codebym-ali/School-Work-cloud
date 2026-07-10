-- Hardening (§24, defense-in-depth): the tenant runtime role (app_user, NOBYPASSRLS)
-- must never be able to read vendor-operator rows (argon2 password hashes). Unlike
-- tenant tables, platform_users has no RLS, and app_user got a DML grant from the
-- schema-wide ALTER DEFAULT PRIVILEGES. app_user has no code path here (the console
-- runs on the platform_admin connection), so revoke it — a tenant-path bug/injection
-- then hits a hard permission error instead of leaking operator credentials.
-- platform_admin (BYPASSRLS) retains access.
REVOKE ALL PRIVILEGES ON TABLE "platform_users" FROM app_user;
