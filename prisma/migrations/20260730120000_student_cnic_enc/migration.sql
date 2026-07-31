-- Student CNIC/B-Form retrievable by an audited admin reveal.
--
-- `cnic_hash` stays: it is the login factor and must remain one-way. This column is the
-- SAME id encrypted (AES-256-GCM), because a hash can answer "does this match?" but can
-- never answer "what is it?" — and a school office has to read a B-Form number back for
-- board registration forms and certificates.
--
-- No backfill is possible: existing rows hold only a digest, which cannot be reversed.
-- Students admitted before this migration therefore show "not provided" until re-entered.
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "cnic_enc" TEXT;
