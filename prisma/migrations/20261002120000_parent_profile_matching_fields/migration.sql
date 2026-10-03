-- Add matching fields to parent_profiles for sibling detection
ALTER TABLE "parent_profiles" ADD COLUMN "cnic_hash" TEXT;
ALTER TABLE "parent_profiles" ADD COLUMN "father_name" TEXT;
ALTER TABLE "parent_profiles" ADD COLUMN "date_of_birth" DATE;
ALTER TABLE "parent_profiles" ADD COLUMN "full_name_norm" TEXT;
ALTER TABLE "parent_profiles" ADD COLUMN "father_name_norm" TEXT;

-- Index for CNIC-based parent lookup (sibling detection)
CREATE INDEX "parent_profiles_school_id_cnic_hash_idx" ON "parent_profiles"("school_id", "cnic_hash");
