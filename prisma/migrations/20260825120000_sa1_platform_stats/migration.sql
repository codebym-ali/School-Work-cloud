-- SA1 — Fleet Overview: a nightly cross-tenant snapshot for the vendor dashboard.
--
-- NOT a tenant table: it aggregates ACROSS all schools, so it carries no school_id and is exempt
-- from RLS (added to NON_TENANT_TABLES in scripts/check-rls-coverage.mjs). Because it is a
-- platform_* table, that same script also asserts app_user (the TENANT runtime role) holds NO
-- privilege on it. The durable REVOKE lives at the END of prisma/sql/06_grants.sql, which re-runs
-- on every db:setup — a one-shot REVOKE in this migration would be handed straight back by the
-- grants companion's blanket GRANT (the 2026-08-24 lesson: whatever runs last wins).

-- CreateTable
CREATE TABLE "platform_stats" (
    "id" UUID NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "schools_total" INTEGER NOT NULL,
    "schools_active" INTEGER NOT NULL,
    "schools_suspended" INTEGER NOT NULL,
    "students_active" INTEGER NOT NULL,
    "staff_employed" INTEGER NOT NULL,
    "new_schools_30d" INTEGER NOT NULL,

    CONSTRAINT "platform_stats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_stats_captured_at_idx" ON "platform_stats"("captured_at");
