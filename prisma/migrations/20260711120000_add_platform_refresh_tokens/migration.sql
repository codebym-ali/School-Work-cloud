-- CreateTable: rotating refresh tokens for vendor-console operators (blueprint §22.4, §24).
-- Not a tenant table — no school_id, no RLS. Holds refresh-token hashes, so (like
-- platform_users) it is revoked from app_user; only platform_admin (BYPASSRLS) may touch it.
CREATE TABLE "platform_refresh_tokens" (
    "id" UUID NOT NULL,
    "platform_user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_refresh_tokens_token_hash_key" ON "platform_refresh_tokens"("token_hash");
CREATE INDEX "platform_refresh_tokens_platform_user_id_family_id_idx" ON "platform_refresh_tokens"("platform_user_id", "family_id");

-- Harden: the tenant runtime role must not read operator refresh-token hashes.
REVOKE ALL PRIVILEGES ON TABLE "platform_refresh_tokens" FROM app_user;
