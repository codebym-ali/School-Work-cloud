-- SA7 — tenant offboarding: schedule a REVERSIBLE termination (a retention window) before the
-- IRREVERSIBLE hard-delete (SA-P5). `purge_after` is the instant the hard-delete becomes allowed;
-- until then, cancelling termination reactivates the school. `termination_reason` is audited context.

-- AlterTable
ALTER TABLE "schools" ADD COLUMN "purge_after" TIMESTAMP(3);
ALTER TABLE "schools" ADD COLUMN "termination_reason" TEXT;
