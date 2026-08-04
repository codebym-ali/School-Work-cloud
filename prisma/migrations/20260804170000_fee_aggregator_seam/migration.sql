-- Aggregator seam (Fee Submission Plan §5.3). The seam only — nothing integrates with it yet.
--
-- ⚠️ CURATED. `prisma migrate diff` also emitted `DROP INDEX "students_full_name_trgm"`, which is
-- owned by `prisma/sql/04_trigram.sql` and invisible to the differ. Taking it would silently kill
-- student name search with no error and no failing test. That is the ELEVENTH time it has been
-- emitted here; `pnpm db:check-migrations` now fails the build on it rather than relying on
-- someone reading the generated SQL. Do not paste the diff in unread.

-- A payment the aggregator reports is not a claim awaiting verification: the bank has already
-- moved the money, so settlement creates the FeePayment directly.
ALTER TYPE "PaymentMethod" ADD VALUE 'ONLINE';

-- The consumer number the parent quotes in their own bank app. Nullable because no school has an
-- aggregator yet, and unique per school so a webhook can address exactly one invoice. Postgres
-- treats NULLs as distinct, so every un-issued invoice coexists happily under this constraint.
ALTER TABLE "fee_invoices" ADD COLUMN "psid" VARCHAR(20);
CREATE UNIQUE INDEX "fee_invoices_school_id_psid_key" ON "fee_invoices"("school_id", "psid");
