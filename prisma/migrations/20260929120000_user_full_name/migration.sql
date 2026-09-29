-- A display name for accounts that have no staff profile — chiefly the school owner, whose header showed a
-- login email because the only name column lived on staff_profiles (Owner UX Phase 2). Nullable, additive,
-- no backfill: an owner with no name keeps seeing their role until they set one on the Security screen.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "full_name" TEXT;
