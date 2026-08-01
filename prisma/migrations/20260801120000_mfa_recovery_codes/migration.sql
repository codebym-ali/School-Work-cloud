-- Single-use MFA recovery codes (§22.5).
--
-- MFA is MANDATORY for OWNER_ADMIN and ACCOUNTANT. Until now there was no recovery path at all:
-- a lost or wiped authenticator locked the school owner out of their own system, and the only
-- remedy was an operator editing `mfa_enabled` / `mfa_secret_enc` directly in the database.
--
-- Codes are argon2 hashes, exactly like passwords — the plaintext is displayed ONCE at
-- generation and is unrecoverable afterwards. `used_at` makes each one single-use.
CREATE TABLE "mfa_recovery_codes" (
  "id"         UUID NOT NULL,
  "school_id"  UUID NOT NULL,
  "user_id"    UUID NOT NULL,
  "code_hash"  TEXT NOT NULL,
  "used_at"    TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mfa_recovery_codes_user_id_school_id_idx" ON "mfa_recovery_codes"("user_id", "school_id");
-- Serves the hot path: fetch a user's UNUSED codes at challenge time.
CREATE INDEX "mfa_recovery_codes_school_id_user_id_used_at_idx" ON "mfa_recovery_codes"("school_id", "user_id", "used_at");

ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_school_id_fkey"
  FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Composite FK carries the tenant chain (audit H-3): a code can never belong to a user in
-- another school, enforced by the database rather than by service code.
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_school_id_fkey"
  FOREIGN KEY ("user_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE CASCADE ON UPDATE CASCADE;
