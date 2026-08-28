-- SA8 — demo/contact requests from the public marketing site. Vendor-side (no school_id, no RLS); it
-- holds prospect PII, so it is allowlisted in check-rls-coverage and revoked from app_user like every
-- platform_* table. Captured by the public POST /platform/public/demo-request; worked from the console.

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'CONVERTED', 'CLOSED');

-- CreateTable
CREATE TABLE "platform_leads" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "school_name" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "student_count" INTEGER,
    "message" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "source" TEXT NOT NULL DEFAULT 'marketing-site',
    "note" TEXT,
    "handled_by_id" UUID,
    "handled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_leads_status_idx" ON "platform_leads"("status");

-- CreateIndex
CREATE INDEX "platform_leads_created_at_idx" ON "platform_leads"("created_at");
