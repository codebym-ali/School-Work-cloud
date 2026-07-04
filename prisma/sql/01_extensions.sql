-- Companion migration 01: extensions (blueprint §17.1).
-- Idempotent; safe to re-run. In production run once against the Coolify Postgres.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
