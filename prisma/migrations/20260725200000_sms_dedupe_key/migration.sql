-- SMS idempotency: a redelivered queue job (BullMQ retry / stalled-worker recovery) must not
-- send the guardian a second message or debit credits twice. The unique index is the claim:
-- the QUEUED row is inserted before the gateway call, so a duplicate insert fails and the
-- send is skipped. NULL is allowed for sends with no natural once-per-event key, and Postgres
-- treats NULLs as distinct, so those rows never collide with each other.
ALTER TABLE "sms_logs" ADD COLUMN "dedupe_key" TEXT;

CREATE UNIQUE INDEX "sms_logs_school_id_dedupe_key_key" ON "sms_logs" ("school_id", "dedupe_key");
