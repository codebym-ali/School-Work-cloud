-- Documents RECEIVED at admission + the parent declaration (Admission Form Field Gaps, Tier 3).
--
-- Additive: one new table and three nullable columns. Nothing here is needed to seat a child — the
-- admission form still admits first — but until now the system could not record WHAT THE FAMILY
-- HANDED IN, which is most of what an admission actually consists of in a Pakistani private school.

-- ── Documents received ──────────────────────────────────────────────────────────────────────────
-- ⚠️ A NEW table rather than reusing `documents`. That one records what the school ISSUES: it
-- carries issued_by_id/issued_at and every DocumentType is a school-produced artifact (leaving
-- certificate, report card, payslip). Receipt runs the other way, with a different actor and a
-- different question, and folding both into one table would make either side lie.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StudentDocumentType') THEN
    CREATE TYPE "StudentDocumentType" AS ENUM (
      'B_FORM',
      'BIRTH_CERTIFICATE',
      'GUARDIAN_CNIC',
      'PREV_SCHOOL_LEAVING',
      'PREV_REPORT_CARD',
      'PHOTOGRAPH',
      'MEDICAL_RECORD',
      'OTHER'
    );
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS "student_documents" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "school_id"      UUID NOT NULL,
  "student_id"     UUID NOT NULL,
  "type"           "StudentDocumentType" NOT NULL,
  "received"       BOOLEAN NOT NULL DEFAULT false,
  "received_at"    TIMESTAMP(3),
  "received_by_id" UUID,
  -- ⚠️ NULLABLE, and it must stay that way. These arrive as photocopies across a counter far more
  -- often than as scans. Requiring an upload to tick the box would make the checklist unusable and
  -- push the office into ticking things that are not true — a register that lies is worse than none.
  "file_key"       TEXT,
  "note"           TEXT,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "student_documents_pkey" PRIMARY KEY ("id")
);

-- One row per (student, document type): ticking the same document twice is a mistake, not history.
CREATE UNIQUE INDEX IF NOT EXISTS "student_documents_student_id_type_key"
  ON "student_documents" ("student_id", "type");
CREATE INDEX IF NOT EXISTS "student_documents_school_id_student_id_idx"
  ON "student_documents" ("school_id", "student_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'student_documents_school_id_fkey') THEN
    ALTER TABLE "student_documents"
      ADD CONSTRAINT "student_documents_school_id_fkey"
      FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
  -- CASCADE: a checklist entry has no meaning without the student it describes.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'student_documents_student_id_school_id_fkey') THEN
    ALTER TABLE "student_documents"
      ADD CONSTRAINT "student_documents_student_id_school_id_fkey"
      FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id")
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
  -- SET NULL, not RESTRICT: who took delivery is useful provenance, but it must never be the reason
  -- a leaving staff member cannot be removed.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'student_documents_received_by_id_school_id_fkey') THEN
    ALTER TABLE "student_documents"
      ADD CONSTRAINT "student_documents_received_by_id_school_id_fkey"
      FOREIGN KEY ("received_by_id", "school_id") REFERENCES "users"("id", "school_id")
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END$$;

-- RLS and grants are NOT written here on purpose: prisma/sql/05_rls.sql enables + FORCEs the
-- tenant_isolation policy on every table carrying school_id, and 06_grants.sql grants DML to the
-- runtime roles. Both re-run on every `db:setup`, so this table is covered by construction — and
-- `db:check-rls` fails the build if it somehow is not.

-- ── Parent/guardian declaration ─────────────────────────────────────────────────────────────────
-- ⚠️ VERSIONED. "The parent agreed" is close to worthless without "agreed to WHAT": the wording
-- changes as fee policy and school rules change, and the version is the only thing that can answer
-- the question actually asked when a declaration is disputed.
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "declaration_version" TEXT;
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "declaration_accepted_at" TIMESTAMP(3);
-- The accepting person's NAME as given, not a user id: whoever signs at the counter rarely has a
-- login at that moment.
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "declaration_accepted_by" TEXT;
