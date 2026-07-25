-- Staff had no name column — the directory could only identify people by email address.
-- Nullable so existing rows stay valid; the UI collects it on create from here on.
ALTER TABLE "staff_profiles" ADD COLUMN "full_name" TEXT;
