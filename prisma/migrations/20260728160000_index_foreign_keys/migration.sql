-- Audit fix #4: index every foreign key on the child side.
--
-- Postgres does NOT create an index for a referencing column. Without one, each DELETE on
-- the parent sequentially scans the child to enforce the constraint, and every join on that
-- column is a scan too. 38 FKs were unindexed, including the ones this codebase joins on
-- constantly: fee_payments.invoice_id, exam_results.enrollment_id, student_enrollments.*.
--
-- Column order matches the FK (child_id, school_id) so the index satisfies the constraint
-- check directly rather than only helping the join.
--
-- NOTE: hand-curated from `prisma migrate diff`, which again wanted to
-- DROP INDEX students_full_name_trgm (owned by the 04_trigram.sql companion, invisible to
-- Prisma) and to drop a column default. Both excluded.

-- CreateIndex
CREATE INDEX "attendance_records_marked_by_id_school_id_idx" ON "attendance_records"("marked_by_id", "school_id");
-- CreateIndex
CREATE INDEX "attendance_records_enrollment_id_school_id_idx" ON "attendance_records"("enrollment_id", "school_id");
-- CreateIndex
CREATE INDEX "discounts_approved_by_id_school_id_idx" ON "discounts"("approved_by_id", "school_id");
-- CreateIndex
CREATE INDEX "exam_definitions_term_id_school_id_idx" ON "exam_definitions"("term_id", "school_id");
-- CreateIndex
CREATE INDEX "exam_results_exam_id_school_id_idx" ON "exam_results"("exam_id", "school_id");
-- CreateIndex
CREATE INDEX "exam_results_subject_id_school_id_idx" ON "exam_results"("subject_id", "school_id");
-- CreateIndex
CREATE INDEX "fee_invoice_batches_academic_year_id_school_id_idx" ON "fee_invoice_batches"("academic_year_id", "school_id");
-- CreateIndex
CREATE INDEX "fee_invoice_items_invoice_id_school_id_idx" ON "fee_invoice_items"("invoice_id", "school_id");
-- CreateIndex
CREATE INDEX "fee_invoices_enrollment_id_school_id_idx" ON "fee_invoices"("enrollment_id", "school_id");
-- CreateIndex
CREATE INDEX "fee_payments_collected_by_id_school_id_idx" ON "fee_payments"("collected_by_id", "school_id");
-- CreateIndex
CREATE INDEX "fee_payments_invoice_id_school_id_idx" ON "fee_payments"("invoice_id", "school_id");
-- CreateIndex
CREATE INDEX "fee_structures_class_id_school_id_idx" ON "fee_structures"("class_id", "school_id");
-- CreateIndex
CREATE INDEX "fee_structures_academic_year_id_school_id_idx" ON "fee_structures"("academic_year_id", "school_id");
-- CreateIndex
CREATE INDEX "fee_structures_fee_head_id_school_id_idx" ON "fee_structures"("fee_head_id", "school_id");
-- CreateIndex
CREATE INDEX "holidays_campus_id_school_id_idx" ON "holidays"("campus_id", "school_id");
-- CreateIndex
CREATE INDEX "inquiries_desired_class_id_school_id_idx" ON "inquiries"("desired_class_id", "school_id");
-- CreateIndex
CREATE INDEX "module_access_user_id_school_id_idx" ON "module_access"("user_id", "school_id");
-- CreateIndex
CREATE INDEX "payslips_run_id_school_id_idx" ON "payslips"("run_id", "school_id");
-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_school_id_idx" ON "refresh_tokens"("user_id", "school_id");
-- CreateIndex
CREATE INDEX "section_subjects_subject_id_school_id_idx" ON "section_subjects"("subject_id", "school_id");
-- CreateIndex
CREATE INDEX "staff_attendance_staff_id_school_id_idx" ON "staff_attendance"("staff_id", "school_id");
-- CreateIndex
CREATE INDEX "staff_leaves_staff_id_school_id_idx" ON "staff_leaves"("staff_id", "school_id");
-- CreateIndex
CREATE INDEX "student_enrollments_class_id_school_id_idx" ON "student_enrollments"("class_id", "school_id");
-- CreateIndex
CREATE INDEX "student_enrollments_student_id_school_id_idx" ON "student_enrollments"("student_id", "school_id");
-- CreateIndex
CREATE INDEX "student_enrollments_section_id_school_id_idx" ON "student_enrollments"("section_id", "school_id");
-- CreateIndex
CREATE INDEX "student_enrollments_campus_id_school_id_idx" ON "student_enrollments"("campus_id", "school_id");
-- CreateIndex
CREATE INDEX "student_guardians_student_id_school_id_idx" ON "student_guardians"("student_id", "school_id");
-- CreateIndex
CREATE INDEX "student_leaves_student_id_school_id_idx" ON "student_leaves"("student_id", "school_id");
-- CreateIndex
CREATE INDEX "subjects_class_id_school_id_idx" ON "subjects"("class_id", "school_id");
-- CreateIndex
CREATE INDEX "teacher_applications_created_by_id_school_id_idx" ON "teacher_applications"("created_by_id", "school_id");
-- CreateIndex
CREATE INDEX "teacher_applications_campus_id_school_id_idx" ON "teacher_applications"("campus_id", "school_id");
-- CreateIndex
CREATE INDEX "teacher_assignments_section_id_school_id_idx" ON "teacher_assignments"("section_id", "school_id");
-- CreateIndex
CREATE INDEX "teacher_assignments_subject_id_school_id_idx" ON "teacher_assignments"("subject_id", "school_id");
-- CreateIndex
CREATE INDEX "teacher_assignments_staff_id_school_id_idx" ON "teacher_assignments"("staff_id", "school_id");
-- CreateIndex
CREATE INDEX "terms_academic_year_id_school_id_idx" ON "terms"("academic_year_id", "school_id");
-- CreateIndex
CREATE INDEX "users_campus_id_school_id_idx" ON "users"("campus_id", "school_id");
-- CreateIndex
CREATE INDEX "vacancies_created_by_id_school_id_idx" ON "vacancies"("created_by_id", "school_id");
-- CreateIndex
CREATE INDEX "vacancies_campus_id_school_id_idx" ON "vacancies"("campus_id", "school_id");
