-- Phone-OTP verification state on parent_profiles (blueprint §14). parent_profiles is a
-- tenant table and already RLS-FORCE'd (prisma/sql/05_rls.sql), so these nullable columns
-- inherit the existing policy — no RLS/companion change needed. Guardian SMS is gated on
-- phone_verified_at; this is the flow that sets it.
ALTER TABLE "parent_profiles"
  ADD COLUMN "otp_code_hash" TEXT,
  ADD COLUMN "otp_expires_at" TIMESTAMP(3),
  ADD COLUMN "otp_attempts" INTEGER NOT NULL DEFAULT 0;
