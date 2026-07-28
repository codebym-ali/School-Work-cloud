-- Referential integrity for relationships that existed only as bare columns: Prisma had no
-- relation field, so no FK was ever generated and the database could not stop an orphan.
-- Real damage found before this ran: 19 report_cards and 5 sms_logs pointing at deleted rows.
--
-- All composite (child_id, school_id) -> parent(id, school_id) so the tenant chain is enforced
-- by the DB itself (§17 audit H-3): a row can never reference another school's record.
-- RESTRICT everywhere — deletes are guarded in the services, which name the blocker.
--
-- NOTE: written by hand rather than taking `prisma migrate diff` wholesale. That diff also
-- wanted to DROP INDEX students_full_name_trgm (owned by the 04_trigram.sql companion, which
-- Prisma cannot see) and to drop a column default. Both were excluded deliberately.

ALTER TABLE "holidays" ADD CONSTRAINT "holidays_campus_id_school_id_fkey" FOREIGN KEY ("campus_id", "school_id") REFERENCES "campuses"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "student_enrollments" ADD CONSTRAINT "student_enrollments_campus_id_school_id_fkey" FOREIGN KEY ("campus_id", "school_id") REFERENCES "campuses"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "student_enrollments" ADD CONSTRAINT "student_enrollments_class_id_school_id_fkey" FOREIGN KEY ("class_id", "school_id") REFERENCES "classes"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_academic_year_id_school_id_fkey" FOREIGN KEY ("academic_year_id", "school_id") REFERENCES "academic_years"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_section_id_school_id_fkey" FOREIGN KEY ("section_id", "school_id") REFERENCES "sections"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_subject_id_school_id_fkey" FOREIGN KEY ("subject_id", "school_id") REFERENCES "subjects"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_desired_class_id_school_id_fkey" FOREIGN KEY ("desired_class_id", "school_id") REFERENCES "classes"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_campus_id_school_id_fkey" FOREIGN KEY ("campus_id", "school_id") REFERENCES "campuses"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_academic_year_id_school_id_fkey" FOREIGN KEY ("academic_year_id", "school_id") REFERENCES "academic_years"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fee_invoice_batches" ADD CONSTRAINT "fee_invoice_batches_class_id_school_id_fkey" FOREIGN KEY ("class_id", "school_id") REFERENCES "classes"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fee_invoice_batches" ADD CONSTRAINT "fee_invoice_batches_academic_year_id_school_id_fkey" FOREIGN KEY ("academic_year_id", "school_id") REFERENCES "academic_years"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
