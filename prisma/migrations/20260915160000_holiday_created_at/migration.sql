-- When the closure was DECLARED, as distinct from the day it describes.
--
-- The notification bell judges "new" on this column. A closure declared tonight for tomorrow has a
-- `date` in the future, so marking it read against that date could never succeed and the unread
-- badge never cleared.
--
-- Existing rows take the migration time. That is the honest answer: nothing recorded when they were
-- declared, and dating them to their own holiday date would reintroduce the bug for future ones.
ALTER TABLE "holidays" ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
