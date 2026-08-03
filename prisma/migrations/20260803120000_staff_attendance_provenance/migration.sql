-- Staff attendance provenance (§9/§13).
--
-- A staff member may assert their own PRESENCE, and `staff_attendance` feeds the payroll
-- attendance deduction — so a record has to carry WHO says so, or oversight is theatre.
-- SELF = the person themselves (presence, today only), ADMIN = the office, SYSTEM = the
-- day-close job. Defaulting to ADMIN needs no backfill: that is exactly what every existing
-- row was, since the only writer until now was the admin bulk endpoint.
--
-- NOTE: hand-curated. `prisma migrate diff` also emitted `DROP INDEX students_full_name_trgm`
-- (the SEVENTH time) — that index is owned by the 04_trigram.sql companion, which Prisma
-- cannot see, and taking it would silently kill student name search. `pnpm db:check-migrations`
-- blocks it in CI; it is removed here as always.

-- CreateEnum
CREATE TYPE "AttendanceSource" AS ENUM ('SELF', 'ADMIN', 'SYSTEM');

-- AlterTable
ALTER TABLE "staff_attendance" ADD COLUMN     "marked_by_id" UUID,
ADD COLUMN     "note" VARCHAR(200),
ADD COLUMN     "source" "AttendanceSource" NOT NULL DEFAULT 'ADMIN';

-- CreateIndex
-- The history drill-down queries one staff member over a date range, ordered by date;
-- [staff_id, school_id] cannot serve that ordering.
CREATE INDEX "staff_attendance_staff_id_date_idx" ON "staff_attendance"("staff_id", "date");

-- CreateIndex
CREATE INDEX "staff_attendance_marked_by_id_school_id_idx" ON "staff_attendance"("marked_by_id", "school_id");

-- AddForeignKey
-- Composite (actor, school) so the FK enforces the tenant chain as well as the reference —
-- an actor from another school is rejected by the database, not merely by service code.
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_marked_by_id_school_id_fkey" FOREIGN KEY ("marked_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
