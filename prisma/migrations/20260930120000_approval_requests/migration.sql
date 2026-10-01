-- Approval requests (Campus Ops Admin plan, 2026-09-30).
--
-- The owner is the read-only overseer; the campus's Ops Admin / accountant asks, the owner approves.
-- VOUCHER_BATCH: a campus's monthly fee vouchers, generated as PENDING_APPROVAL invoices.
-- SETUP_CHANGE: a school-wide setup write proposed by the Ops Admin; approval replays it.
--
-- PENDING_APPROVAL is only ADDED here, not used in this migration (Postgres forbids using a new enum value in
-- the transaction that added it). It is placed first, so nothing that sorts by enum order changes meaning.
-- NOTE: hand-curated (prisma migrate diff keeps proposing DROP INDEX students_full_name_trgm — a 04_trigram.sql index).

-- AlterEnum
ALTER TYPE "FeeInvoiceStatus" ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL' BEFORE 'PENDING';

-- CreateEnum
CREATE TYPE "ApprovalType" AS ENUM ('VOUCHER_BATCH', 'SETUP_CHANGE');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "type" "ApprovalType" NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "campus_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "payload" JSONB NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "decision_note" VARCHAR(300),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_id_school_id_key" ON "approval_requests"("id", "school_id");
CREATE INDEX "approval_requests_school_id_status_idx" ON "approval_requests"("school_id", "status");
CREATE INDEX "approval_requests_campus_id_school_id_idx" ON "approval_requests"("campus_id", "school_id");
CREATE INDEX "approval_requests_requested_by_id_school_id_idx" ON "approval_requests"("requested_by_id", "school_id");
CREATE INDEX "approval_requests_decided_by_id_school_id_idx" ON "approval_requests"("decided_by_id", "school_id");

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_campus_id_school_id_fkey" FOREIGN KEY ("campus_id", "school_id") REFERENCES "campuses"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_id_school_id_fkey" FOREIGN KEY ("requested_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_id_school_id_fkey" FOREIGN KEY ("decided_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
