-- Bank statement reconciliation (Fees Gaps Register — reconciliation CSV).
--
-- The accountant currently matches each claim against a statement open in another window, by eye.
-- These tables let the statement be uploaded so the MATCHING is automatic.
--
-- ⚠️ Matching is evidence, never a decision. Nothing here can verify a claim or write a payment:
-- verification stays a human act on the ordinary payment path, with a named verifier recorded for
-- ever. Auto-verifying a screenshot is how a school gets defrauded.

CREATE TABLE IF NOT EXISTS "bank_statements" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "school_id"      UUID NOT NULL,
  -- Also the key the saved column mapping is remembered against, so a second upload from the same
  -- bank needs no mapping.
  "bank_label"     TEXT NOT NULL,
  "file_name"      TEXT,
  "period_from"    DATE,
  "period_to"      DATE,
  "line_count"     INTEGER NOT NULL DEFAULT 0,
  "uploaded_by_id" UUID,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bank_statements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "bank_statement_lines" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "school_id"        UUID NOT NULL,
  "statement_id"     UUID NOT NULL,
  -- The day the money moved, compared against a claim's `paid_on`. NOT the upload date: a transfer
  -- made on the 8th and sent in on the 12th was still made on the 8th.
  "value_date"       DATE NOT NULL,
  "amount"           DECIMAL(12,2) NOT NULL,
  -- Kept whole. References are routinely buried inside narration (`IBFT/TX88231/AYESHA`), and the
  -- tier-2 matcher reads it.
  "narration"        VARCHAR(500) NOT NULL,
  "reference"        TEXT,
  "counterparty"     VARCHAR(200),
  -- ⚠️ Hash of (value_date, amount, reference, narration). Unique per school, so re-uploading the
  -- same statement — or an overlapping date range, which is what people actually do — writes
  -- nothing. Same discipline as Idempotency-Key on payments.
  "fingerprint"      TEXT NOT NULL,
  "matched_claim_id" UUID,
  "matched_at"       TIMESTAMP(3),
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "bank_statement_lines_school_id_fingerprint_key"
  ON "bank_statement_lines" ("school_id", "fingerprint");
CREATE UNIQUE INDEX IF NOT EXISTS "bank_statement_lines_matched_claim_id_school_id_key"
  ON "bank_statement_lines" ("matched_claim_id", "school_id");
CREATE INDEX IF NOT EXISTS "bank_statement_lines_school_id_value_date_idx"
  ON "bank_statement_lines" ("school_id", "value_date");
CREATE INDEX IF NOT EXISTS "bank_statement_lines_school_id_matched_claim_id_idx"
  ON "bank_statement_lines" ("school_id", "matched_claim_id");
CREATE INDEX IF NOT EXISTS "bank_statements_school_id_created_at_idx"
  ON "bank_statements" ("school_id", "created_at");

-- The composite target the line's claim relation points at.
CREATE UNIQUE INDEX IF NOT EXISTS "fee_payment_claims_id_school_id_key"
  ON "fee_payment_claims" ("id", "school_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_statements_school_id_fkey') THEN
    ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_school_id_fkey"
      FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
  -- SET NULL, not RESTRICT: who uploaded is useful provenance, never a reason a departing
  -- accountant cannot be removed.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_statements_uploaded_by_id_school_id_fkey') THEN
    ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_uploaded_by_id_school_id_fkey"
      FOREIGN KEY ("uploaded_by_id", "school_id") REFERENCES "users"("id", "school_id")
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_statement_lines_school_id_fkey') THEN
    ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_school_id_fkey"
      FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
  -- CASCADE: a line has no meaning without the statement it came from.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_statement_lines_statement_id_fkey') THEN
    ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_statement_id_fkey"
      FOREIGN KEY ("statement_id") REFERENCES "bank_statements"("id") ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
  -- SET NULL: unmatching a claim must never delete the bank's record of the money.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_statement_lines_matched_claim_id_school_id_fkey') THEN
    ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_matched_claim_id_school_id_fkey"
      FOREIGN KEY ("matched_claim_id", "school_id") REFERENCES "fee_payment_claims"("id", "school_id")
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END$$;

-- RLS and grants are not written here: prisma/sql/05_rls.sql enables + FORCEs tenant_isolation on
-- every table carrying school_id, and 06_grants.sql grants DML to the runtime roles. Both re-run on
-- every db:setup, and db:check-rls fails the build if a table is somehow missed.
