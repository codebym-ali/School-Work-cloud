-- A cheque is not money until it clears (Fee Submission Plan, D3).
--
-- D3 was recorded as a decision to confirm and never built: "a claim stays PENDING until the
-- clearing date rather than being verified on receipt — otherwise a bounced cheque has already
-- issued a receipt." `chequeClearingDays` has been in settings, read by nothing, ever since.
--
-- ⚠️ STORED rather than derived from `paid_on + chequeClearingDays` at read time. A cheque accepted
-- when the school held them 3 days must not re-date itself because someone later sets 7: the
-- clearing date is a fact about THIS cheque, agreed at the counter when it was taken.
ALTER TABLE "fee_payment_claims" ADD COLUMN IF NOT EXISTS "clears_on" DATE;

-- Existing CHEQUE payments are deliberately NOT rewritten. They already issued receipts, and
-- "turning a method off never rewrites history" applies here too — this changes what happens next,
-- never what was already recorded.
