-- Proof of payment (§12/§22.6).
--
-- A storage key, never a URL: the object stays private and is served only through a
-- short-lived presigned link, behind the same authorization as the payment it belongs to.
-- Nullable because cash over the counter has no proof and none should be demanded.
--
-- NOTE: hand-curated. `prisma migrate diff` again emitted `DROP INDEX students_full_name_trgm`
-- (the NINTH time) — that index belongs to the 04_trigram.sql companion, which Prisma cannot
-- see, and taking it would silently kill student name search.

-- AlterTable
ALTER TABLE "fee_payments" ADD COLUMN     "proof_file_key" TEXT;
