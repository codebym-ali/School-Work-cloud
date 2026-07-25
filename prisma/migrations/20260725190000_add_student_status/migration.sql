-- Student lifecycle status (person-level), distinct from student_enrollments.status (seat-level).
CREATE TYPE "StudentStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'RESTRICTED', 'STRUCK_OFF', 'WITHDRAWN', 'GRADUATED');

ALTER TABLE "students"
  ADD COLUMN "status" "StudentStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "status_reason" TEXT,
  ADD COLUMN "status_effective_from" DATE,
  ADD COLUMN "status_ends_on" DATE;

-- Backfill from the boolean this replaces. A soft-deleted row is a removed record, not a
-- lifecycle state, so it keeps ACTIVE and stays excluded by deleted_at as before.
UPDATE "students" SET "status" = 'STRUCK_OFF' WHERE "is_active" = false AND "deleted_at" IS NULL;

CREATE INDEX "students_school_id_status_idx" ON "students" ("school_id", "status");
