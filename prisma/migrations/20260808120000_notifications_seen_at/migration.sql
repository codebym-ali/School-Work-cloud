-- Notifications Plan, N1: the whole of "unread", in one column.
--
-- Notifications are derived from the records they describe, never stored, so there is no row to
-- carry a read flag. Anything whose underlying record changed after this timestamp renders as
-- new. NULL means "never opened", which correctly makes everything new the first time.
ALTER TABLE "users" ADD COLUMN "notifications_seen_at" TIMESTAMP(3);

-- ⚠️ `prisma migrate diff` also emitted `DROP INDEX "students_full_name_trgm"` here — the
-- TWELFTH time. It is a SQL companion (prisma/sql/*.sql) that the Prisma schema cannot see, so
-- every diff proposes destroying it; taking that would silently remove student name search with
-- no error and no failing test. Curated out by hand, and `pnpm db:check-migrations` fails the
-- build on it rather than trusting anyone to read this file.
