-- SA4b — operator onboarding. A vendor operator can be INVITED (no password yet), and a one-time
-- token lets them set their own password — the platform mirror of the tenant password_reset_tokens,
-- keyed by platform_user_id. Non-tenant (no school_id, no RLS): grants are its only access control,
-- so the durable REVOKE lives at the end of 06_grants.sql (added to the list there and to the
-- NON_TENANT allowlist in check-rls-coverage.mjs).

-- AlterTable: an INVITED operator has no password until they set one via the onboarding link.
ALTER TABLE "platform_users" ALTER COLUMN "password_hash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "platform_password_reset_tokens" (
    "id" UUID NOT NULL,
    "platform_user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_password_reset_tokens_token_hash_key" ON "platform_password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "platform_password_reset_tokens_platform_user_id_idx" ON "platform_password_reset_tokens"("platform_user_id");
