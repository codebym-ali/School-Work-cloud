-- Fee payment claims (§12) — "somebody says they have paid".
--
-- A claim is NOT a payment. An unverified screenshot must never mint a receipt number, move
-- paid_amount, appear in collections or clear a defaulter: the office reconciles against the
-- bank statement, and a screenshot is only a claim until it does. Verifying one creates the
-- real fee_payment through the ordinary payment path, so idempotency, the row lock, the
-- gap-free receipt sequence and the receipt SMS all keep applying unchanged.
--
-- payment_id is the bridge: from a receipt you can reach the evidence that justified it, and
-- from a claim the receipt it produced.
--
-- NOTE: hand-curated. `prisma migrate diff` again emitted
-- `DROP INDEX students_full_name_trgm` (the TENTH time) — that index belongs to the
-- 04_trigram.sql companion, is invisible to Prisma, and dropping it kills student name search.

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ClaimSource" AS ENUM ('OFFICE', 'STUDENT_PORTAL', 'GUARDIAN_LINK');

-- CreateTable
CREATE TABLE "fee_payment_claims" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "transaction_ref" TEXT,
    "paid_on" DATE NOT NULL,
    "proof_file_key" TEXT,
    "note" VARCHAR(300),
    "status" "ClaimStatus" NOT NULL DEFAULT 'PENDING',
    "source" "ClaimSource" NOT NULL,
    "submitted_by_id" UUID,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "rejection_reason" VARCHAR(300),
    "payment_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fee_payment_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fee_payment_claims_payment_id_key" ON "fee_payment_claims"("payment_id");

-- CreateIndex
CREATE INDEX "fee_payment_claims_school_id_status_idx" ON "fee_payment_claims"("school_id", "status");

-- CreateIndex
CREATE INDEX "fee_payment_claims_student_id_school_id_idx" ON "fee_payment_claims"("student_id", "school_id");

-- CreateIndex
CREATE INDEX "fee_payment_claims_invoice_id_school_id_idx" ON "fee_payment_claims"("invoice_id", "school_id");

-- CreateIndex
CREATE INDEX "fee_payment_claims_submitted_by_id_school_id_idx" ON "fee_payment_claims"("submitted_by_id", "school_id");

-- CreateIndex
CREATE INDEX "fee_payment_claims_reviewed_by_id_school_id_idx" ON "fee_payment_claims"("reviewed_by_id", "school_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_payment_claims_payment_id_school_id_key" ON "fee_payment_claims"("payment_id", "school_id");

-- AddForeignKey
ALTER TABLE "fee_payment_claims" ADD CONSTRAINT "fee_payment_claims_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payment_claims" ADD CONSTRAINT "fee_payment_claims_student_id_school_id_fkey" FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payment_claims" ADD CONSTRAINT "fee_payment_claims_invoice_id_school_id_fkey" FOREIGN KEY ("invoice_id", "school_id") REFERENCES "fee_invoices"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payment_claims" ADD CONSTRAINT "fee_payment_claims_submitted_by_id_school_id_fkey" FOREIGN KEY ("submitted_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payment_claims" ADD CONSTRAINT "fee_payment_claims_reviewed_by_id_school_id_fkey" FOREIGN KEY ("reviewed_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payment_claims" ADD CONSTRAINT "fee_payment_claims_payment_id_school_id_fkey" FOREIGN KEY ("payment_id", "school_id") REFERENCES "fee_payments"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
