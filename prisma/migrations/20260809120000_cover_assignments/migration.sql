-- Cover (C0): who is taking a class today when the teacher who normally does is away.
--
-- Before this, a substitute standing in the room could not mark the register at all —
-- `assertCanMark` requires a TeacherAssignment — so only an admin could close it and someone had
-- to walk to the office. This table is what makes the person actually in the room able to record
-- who turned up.

-- Housekeeping first: the timetable migration added `DEFAULT CURRENT_TIMESTAMP` to `updated_at`
-- by hand, as a guard in case the table had rows (it could not have — nothing could write it).
-- The Prisma schema does not declare that default, so every `migrate diff` since has proposed
-- removing it. Taking it now: Prisma always writes `updatedAt` explicitly, and permanent drift in
-- a diff is how people learn to skim diffs — which is exactly how the trigram index nearly died.
ALTER TABLE "timetable_slots" ALTER COLUMN "updated_at" DROP DEFAULT;

CREATE TABLE "cover_assignments" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "section_id" UUID NOT NULL,
    -- NULL means "all day", which is how a school with no published timetable works.
    "period_no" INTEGER,
    "covering_staff_id" UUID NOT NULL,
    -- Nullable: a class can need someone for reasons the register does not know.
    "absent_staff_id" UUID,
    "reason" VARCHAR(200),
    -- Who granted the access. Never nullable.
    "arranged_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cover_assignments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cover_assignments_school_id_covering_staff_id_date_idx" ON "cover_assignments"("school_id", "covering_staff_id", "date");
CREATE INDEX "cover_assignments_school_id_section_id_date_idx" ON "cover_assignments"("school_id", "section_id", "date");
CREATE INDEX "cover_assignments_absent_staff_id_school_id_idx" ON "cover_assignments"("absent_staff_id", "school_id");
CREATE INDEX "cover_assignments_arranged_by_id_school_id_idx" ON "cover_assignments"("arranged_by_id", "school_id");

-- Every key is tenant-chained on (id, school_id), so a cover row can only ever reference rows
-- inside its own school — enforced by the database rather than by the application remembering.
ALTER TABLE "cover_assignments" ADD CONSTRAINT "cover_assignments_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cover_assignments" ADD CONSTRAINT "cover_assignments_section_id_school_id_fkey" FOREIGN KEY ("section_id", "school_id") REFERENCES "sections"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cover_assignments" ADD CONSTRAINT "cover_assignments_covering_staff_id_school_id_fkey" FOREIGN KEY ("covering_staff_id", "school_id") REFERENCES "staff_profiles"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cover_assignments" ADD CONSTRAINT "cover_assignments_absent_staff_id_school_id_fkey" FOREIGN KEY ("absent_staff_id", "school_id") REFERENCES "staff_profiles"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cover_assignments" ADD CONSTRAINT "cover_assignments_arranged_by_id_school_id_fkey" FOREIGN KEY ("arranged_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ⚠️ The two UNIQUE indexes that stop a class having two owners are NOT here. They are PARTIAL
-- (on `period_no IS NULL` / `IS NOT NULL`), which Prisma's schema cannot express, so they live in
-- `prisma/sql/02_partial_uniques.sql` and are applied by `pnpm db:setup`. A plain
-- UNIQUE(section_id, date, period_no) would NOT work: Postgres treats NULLs as distinct, so two
-- whole-day covers for one section on one date would both be accepted.

-- ⚠️ `migrate diff` also emitted `DROP INDEX "students_full_name_trgm"` — the FOURTEENTH time.
-- Curated out; `pnpm db:check-migrations` fails the build on it.
