-- SA6 — vendor billing (decision D3: in-house, per-student). The VENDOR charges each school a monthly
-- rate PER ACTIVE STUDENT. `schools.price_per_student` is that settable rate; `platform_invoices` is the
-- vendor's own revenue record (NOT tenant data — references the school by `tenant_id`, ON DELETE SET NULL
-- so the billing history outlives an SA7 purge). Amounts are frozen at issue time.

-- AlterTable: the settable per-student rate on the school (null = not priced yet).
ALTER TABLE "schools" ADD COLUMN "price_per_student" DECIMAL(12,2);

-- CreateEnum
CREATE TYPE "PlatformInvoiceStatus" AS ENUM ('ISSUED', 'PAID', 'VOID');

-- CreateTable
CREATE TABLE "platform_invoices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "tenant_subdomain" TEXT NOT NULL,
    "period_year" INTEGER NOT NULL,
    "period_month" INTEGER NOT NULL,
    "student_count" INTEGER NOT NULL,
    "price_per_student" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PKR',
    "status" "PlatformInvoiceStatus" NOT NULL DEFAULT 'ISSUED',
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_at" TIMESTAMP(3) NOT NULL,
    "paid_at" TIMESTAMP(3),
    "payment_method" TEXT,
    "payment_reference" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_invoices_tenant_id_period_year_period_month_key" ON "platform_invoices"("tenant_id", "period_year", "period_month");

-- CreateIndex
CREATE INDEX "platform_invoices_tenant_id_idx" ON "platform_invoices"("tenant_id");

-- CreateIndex
CREATE INDEX "platform_invoices_status_idx" ON "platform_invoices"("status");

-- AddForeignKey: vendor billing outlives the tenant — SET NULL, never block the SA7 purge, never cascade
-- away a financial record.
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "schools"("id") ON DELETE SET NULL ON UPDATE CASCADE;
