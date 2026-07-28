-- Audit fix #3: identity that a REMOVED record must not keep holding.
--
-- `users(school_id, email)`, `students(school_id, gr_number)` and
-- `students(school_id, registration_no)` were plain UNIQUEs, which span soft-deleted rows.
-- Consequences seen in practice: a departed teacher owned their email address for ever
-- ("Someone already uses the email …" with no visible record to clear), and a mis-keyed
-- admission owned its GR number for ever.
--
-- Deleting means "this record should never have existed" — students.service.softDelete
-- refuses once fee payments or certificates are attached — so only mistakes free their
-- identifier. A WITHDRAWN or STRUCK_OFF student is NOT deleted and keeps their GR number,
-- which is what a school register requires.
--
-- The partial indexes are CREATED FIRST so uniqueness never lapses, even for the instant
-- between statements. They are mirrored in prisma/sql/02_partial_uniques.sql (the project's
-- home for constraints Prisma cannot express); both use IF NOT EXISTS, so whichever runs
-- second is a no-op.
--
-- NOTE: hand-written, not raw `prisma migrate diff` output — that also wanted to
-- DROP INDEX students_full_name_trgm (owned by the 04_trigram.sql companion, invisible to
-- Prisma) and to drop a column default. Both excluded deliberately.

CREATE UNIQUE INDEX IF NOT EXISTS users_one_live_email_per_school
  ON users (school_id, email)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS students_one_live_gr_number_per_school
  ON students (school_id, gr_number)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS students_one_live_registration_no_per_school
  ON students (school_id, registration_no)
  WHERE deleted_at IS NULL;

DROP INDEX IF EXISTS "users_school_id_email_key";
DROP INDEX IF EXISTS "students_school_id_gr_number_key";
DROP INDEX IF EXISTS "students_school_id_registration_no_key";
