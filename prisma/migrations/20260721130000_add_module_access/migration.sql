-- Per-user module access overrides (owner-controlled functionality toggles). RLS + grants are
-- applied to this new school_id table automatically by the SQL companions (05_rls.sql loop /
-- 06_grants.sql).

-- CreateTable
CREATE TABLE "module_access" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "module_key" TEXT NOT NULL,
    "allowed" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "module_access_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "module_access_user_id_module_key_key" ON "module_access"("user_id", "module_key");

-- CreateIndex
CREATE INDEX "module_access_school_id_idx" ON "module_access"("school_id");

-- AddForeignKey
ALTER TABLE "module_access" ADD CONSTRAINT "module_access_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "module_access" ADD CONSTRAINT "module_access_user_id_school_id_fkey" FOREIGN KEY ("user_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE CASCADE ON UPDATE CASCADE;
