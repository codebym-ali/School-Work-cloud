-- Effective-dated fee structures (§12).
--
-- A fee revision must be a NEW row with a later start date, never an edit of the old one:
-- invoices already issued were computed from the price in force at the time, and rewriting
-- that price would silently restate what families were charged. Without this column a school
-- could not re-price mid-year at all, and a mis-keyed amount could never be corrected — the
-- old unique key allowed exactly one row per class/head/year/frequency.
--
-- NOTE: hand-curated. `prisma migrate diff` also emitted `DROP INDEX students_full_name_trgm`
-- (the EIGHTH time) — owned by the 04_trigram.sql companion, invisible to Prisma, and taking
-- it would silently kill student name search. Removed here; `pnpm db:check-migrations` blocks
-- it in CI.

-- AlterTable
ALTER TABLE "fee_structures" ADD COLUMN     "effective_from" DATE NOT NULL DEFAULT CURRENT_DATE;

-- Backfill: an existing price has always applied to its whole academic year, so it starts on
-- the year's first day — NOT today, which would make every historical invoice look as though
-- it had been billed before any price existed.
UPDATE "fee_structures" fs
SET "effective_from" = ay."start_date"::date
FROM "academic_years" ay
WHERE ay."id" = fs."academic_year_id";

-- DropIndex
DROP INDEX "fee_structures_class_id_fee_head_id_academic_year_id_freque_key";

-- CreateIndex
CREATE UNIQUE INDEX "fee_structures_class_id_fee_head_id_academic_year_id_freque_key" ON "fee_structures"("class_id", "fee_head_id", "academic_year_id", "frequency", "effective_from");
