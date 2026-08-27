-- SA6c — opt-in auto-reactivate on payment. `schools.suspended_reason` records WHY a school is
-- suspended ('NON_PAYMENT' from dunning vs 'MANUAL' from an operator), so auto-reactivate can un-suspend
-- a non-payment lock without ever touching a manual/legal hold. `platform_settings` is the vendor-wide
-- switch (single row, default OFF) — the operator opts in.

-- AlterTable
ALTER TABLE "schools" ADD COLUMN "suspended_reason" TEXT;

-- CreateTable
CREATE TABLE "platform_settings" (
    "id" UUID NOT NULL,
    "auto_reactivate_on_payment" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);
