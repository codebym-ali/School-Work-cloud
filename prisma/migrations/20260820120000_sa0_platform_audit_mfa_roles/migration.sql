-- SA0 — SuperAdmin control-plane foundation: platform audit log + platform MFA + role split.
--
-- All additions are on the VENDOR side (platform_users and two new platform_* tables): NOT
-- tenant tables — no school_id, no RLS. The two new tables hold operator data (the audit
-- trail and argon2 recovery-code hashes), so — exactly like platform_users /
-- platform_refresh_tokens — they are revoked from app_user; only platform_admin (BYPASSRLS)
-- may touch them (SA-P4). Both are added to NON_TENANT_TABLES in check-rls-coverage.mjs.

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('SUPER_ADMIN', 'SUPPORT', 'BILLING', 'ANALYST');

-- AlterTable: operators get a role (privilege split) and a second factor (SA0).
ALTER TABLE "platform_users"
    ADD COLUMN "role" "PlatformRole" NOT NULL DEFAULT 'SUPER_ADMIN',
    ADD COLUMN "mfa_secret_enc" TEXT,
    ADD COLUMN "mfa_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: every platform write appends an audit row (SA-P2).
CREATE TABLE "platform_audit_logs" (
    "id" UUID NOT NULL,
    "platform_user_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "target_tenant_id" UUID,
    "metadata" JSONB,
    "reason" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_audit_logs_platform_user_id_idx" ON "platform_audit_logs"("platform_user_id");
CREATE INDEX "platform_audit_logs_target_tenant_id_idx" ON "platform_audit_logs"("target_tenant_id");

-- CreateTable: single-use MFA recovery codes for operators (mirrors mfa_recovery_codes).
CREATE TABLE "platform_mfa_recovery_codes" (
    "id" UUID NOT NULL,
    "platform_user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_mfa_recovery_codes_code_hash_key" ON "platform_mfa_recovery_codes"("code_hash");
CREATE INDEX "platform_mfa_recovery_codes_platform_user_id_idx" ON "platform_mfa_recovery_codes"("platform_user_id");

-- Harden (§24, SA-P4): the tenant runtime role must never read operator MFA/audit data.
-- app_user has no code path here (the console runs on the platform_admin connection), so a
-- tenant-path bug/injection hits a hard permission error instead of leaking operator data.
REVOKE ALL PRIVILEGES ON TABLE "platform_audit_logs" FROM app_user;
REVOKE ALL PRIVILEGES ON TABLE "platform_mfa_recovery_codes" FROM app_user;
