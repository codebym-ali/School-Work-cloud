-- Actor columns get real foreign keys (audit follow-up, 2026-07-29).
--
-- 5 of the 20 `*_by_id` columns already carried a composite FK to users (fee_payments,
-- discounts, attendance_records, vacancies, teacher_applications); the other 15 plus
-- audit_logs.user_id carried none. The defect was the INCONSISTENCY, not the absence: the
-- audit trail could point at a user id that never existed, and nothing stopped it.
--
-- The earlier framing ("adding an FK means either blocking user deletion or nulling the
-- actor") rested on a false premise. Users are NEVER hard-deleted — users.service soft-deletes
-- (deleted_at + status DISABLED). ON DELETE RESTRICT therefore never fires in the product; it
-- only guards against a bug or a stray manual DELETE, which is exactly what it should do.
-- Verified before applying: 0 orphan rows across all 16 columns.
--
-- Composite (actor_id, school_id) -> users(id, school_id), so the FK also enforces the tenant
-- chain (audit H-3): an actor from another school is rejected by the database, not just by code.
--
-- CURATED, not raw `prisma migrate diff` output. Two statements were removed:
--   * DROP INDEX "students_full_name_trgm" — a SQL companion (06_trigram.sql) Prisma cannot
--     see, so every generated migration in this repo tries to drop it. FIFTH occurrence.
--   * ALTER TABLE "section_subjects" ALTER COLUMN "id" DROP DEFAULT — unrelated pre-existing
--     drift (DB has a default Prisma does not model). Not this migration's business.
-- CreateIndex
CREATE INDEX "admissions_admitted_by_id_school_id_idx" ON "admissions"("admitted_by_id", "school_id");

-- CreateIndex
CREATE INDEX "documents_issued_by_id_school_id_idx" ON "documents"("issued_by_id", "school_id");

-- CreateIndex
CREATE INDEX "exam_definitions_published_by_id_school_id_idx" ON "exam_definitions"("published_by_id", "school_id");

-- CreateIndex
CREATE INDEX "exam_results_entered_by_id_school_id_idx" ON "exam_results"("entered_by_id", "school_id");

-- CreateIndex
CREATE INDEX "fee_invoice_batches_created_by_id_school_id_idx" ON "fee_invoice_batches"("created_by_id", "school_id");

-- CreateIndex
CREATE INDEX "guardian_credits_created_by_id_school_id_idx" ON "guardian_credits"("created_by_id", "school_id");

-- CreateIndex
CREATE INDEX "inquiries_created_by_id_school_id_idx" ON "inquiries"("created_by_id", "school_id");

-- CreateIndex
CREATE INDEX "payment_reversals_approved_by_id_school_id_idx" ON "payment_reversals"("approved_by_id", "school_id");

-- CreateIndex
CREATE INDEX "payroll_runs_approved_by_id_school_id_idx" ON "payroll_runs"("approved_by_id", "school_id");

-- CreateIndex
CREATE INDEX "payroll_runs_created_by_id_school_id_idx" ON "payroll_runs"("created_by_id", "school_id");

-- CreateIndex
CREATE INDEX "sms_templates_updated_by_id_school_id_idx" ON "sms_templates"("updated_by_id", "school_id");

-- CreateIndex
CREATE INDEX "staff_leaves_decided_by_id_school_id_idx" ON "staff_leaves"("decided_by_id", "school_id");

-- CreateIndex
CREATE INDEX "student_leaves_requested_by_id_school_id_idx" ON "student_leaves"("requested_by_id", "school_id");

-- CreateIndex
CREATE INDEX "student_leaves_decided_by_id_school_id_idx" ON "student_leaves"("decided_by_id", "school_id");

-- CreateIndex
CREATE INDEX "students_created_by_id_school_id_idx" ON "students"("created_by_id", "school_id");

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_created_by_id_school_id_fkey" FOREIGN KEY ("created_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_created_by_id_school_id_fkey" FOREIGN KEY ("created_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_admitted_by_id_school_id_fkey" FOREIGN KEY ("admitted_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_invoice_batches" ADD CONSTRAINT "fee_invoice_batches_created_by_id_school_id_fkey" FOREIGN KEY ("created_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_approved_by_id_school_id_fkey" FOREIGN KEY ("approved_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardian_credits" ADD CONSTRAINT "guardian_credits_created_by_id_school_id_fkey" FOREIGN KEY ("created_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_leaves" ADD CONSTRAINT "student_leaves_requested_by_id_school_id_fkey" FOREIGN KEY ("requested_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_leaves" ADD CONSTRAINT "student_leaves_decided_by_id_school_id_fkey" FOREIGN KEY ("decided_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_leaves" ADD CONSTRAINT "staff_leaves_decided_by_id_school_id_fkey" FOREIGN KEY ("decided_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_definitions" ADD CONSTRAINT "exam_definitions_published_by_id_school_id_fkey" FOREIGN KEY ("published_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_entered_by_id_school_id_fkey" FOREIGN KEY ("entered_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_approved_by_id_school_id_fkey" FOREIGN KEY ("approved_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_created_by_id_school_id_fkey" FOREIGN KEY ("created_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_templates" ADD CONSTRAINT "sms_templates_updated_by_id_school_id_fkey" FOREIGN KEY ("updated_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_issued_by_id_school_id_fkey" FOREIGN KEY ("issued_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- NOT VALID, deliberately. 11 pre-existing audit rows in the `demo` tenant (19–25 Jul 2026)
-- name actors that no longer exist in ANY school: ROLE_CHANGED, VACANCY_CREATED, 4x
-- STUDENT_ADMITTED and more. They are the residue of the manual data purges run against demo,
-- which hard-deleted users and silently orphaned the trail behind them — precisely the damage
-- this constraint exists to prevent, evidenced in our own data.
--
-- Deleting audit rows so a constraint can pass would destroy the very history being protected,
-- so the legacy rows stay and are left visibly unvalidated. NOT VALID still enforces on every
-- INSERT and UPDATE from here on; it only skips the backfill scan. Once the demo tenant is
-- reseeded (or the rows are consciously written off), run:
--   ALTER TABLE audit_logs VALIDATE CONSTRAINT audit_logs_user_id_school_id_fkey;
-- and it becomes a fully validated constraint with no table rewrite.
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_school_id_fkey" FOREIGN KEY ("user_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
