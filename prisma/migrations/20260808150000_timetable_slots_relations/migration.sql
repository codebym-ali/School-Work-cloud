-- Timetables, TT0: make `timetable_slots` a table the product can actually use.
--
-- It has existed since the first schema with raw ids, no relations and no foreign keys — so
-- nothing could join to it, no endpoint wrote to it, and the only code touching it anywhere was
-- two `count()` calls in delete-guards asking whether a section or subject had slots. That count
-- was structurally always zero. This adds the keys and the columns a real grid needs.

-- `updated_at` is NOT NULL. Prisma's own diff emits it without a default, which would fail on any
-- table that already had rows. This one is empty everywhere by construction — nothing has ever
-- been able to insert — but relying on that to make a migration safe is the sort of assumption
-- that is true right up until it is not, so it carries a default.
ALTER TABLE "timetable_slots" ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "timetable_slots" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
-- Optional free text: "Lab 2", "Ground". A school that does not track rooms leaves it null rather
-- than being made to invent one.
ALTER TABLE "timetable_slots" ADD COLUMN "room" VARCHAR(40);

CREATE INDEX "timetable_slots_school_id_academic_year_id_section_id_idx" ON "timetable_slots"("school_id", "academic_year_id", "section_id");
CREATE INDEX "timetable_slots_subject_id_school_id_idx" ON "timetable_slots"("subject_id", "school_id");
CREATE INDEX "timetable_slots_staff_id_school_id_idx" ON "timetable_slots"("staff_id", "school_id");

-- Every key is tenant-chained on (id, school_id), like TeacherAssignment — a slot can only ever
-- reference rows inside its own school, enforced by the database rather than by the application
-- remembering to check. ON DELETE RESTRICT: a subject or a teacher with periods on the timetable
-- cannot be deleted out from under it, which is what the two delete-guards were always for.
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_academic_year_id_school_id_fkey" FOREIGN KEY ("academic_year_id", "school_id") REFERENCES "academic_years"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_section_id_school_id_fkey" FOREIGN KEY ("section_id", "school_id") REFERENCES "sections"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_subject_id_school_id_fkey" FOREIGN KEY ("subject_id", "school_id") REFERENCES "subjects"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_staff_id_school_id_fkey" FOREIGN KEY ("staff_id", "school_id") REFERENCES "staff_profiles"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ⚠️ `prisma migrate diff` also emitted `DROP INDEX "students_full_name_trgm"` — the THIRTEENTH
-- time. It is a SQL companion (prisma/sql/*.sql) the Prisma schema cannot see, so every diff
-- proposes destroying it; taking it would silently remove student name search with no error and
-- no failing test. Curated out by hand; `pnpm db:check-migrations` fails the build on it.
