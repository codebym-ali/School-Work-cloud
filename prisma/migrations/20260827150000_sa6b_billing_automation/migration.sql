-- SA6b — billing automation. The auto-invoice and dunning auto-suspend jobs are SYSTEM actions with
-- no operator, so a platform_audit_logs row can now carry a null actor ("the system did this").
-- Operator writes still set platform_user_id; this only relaxes the NOT NULL for automated rows.
ALTER TABLE "platform_audit_logs" ALTER COLUMN "platform_user_id" DROP NOT NULL;
