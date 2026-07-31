-- Class tests: formative assessment set by the subject teacher.
--
-- Deliberately NOT modelled on exam_definitions. An exam carries weightage_percent that must sum
-- to 100 per class and drives report-card generation, so every ad-hoc quiz created as an exam
-- would break the report card and drag the quiz into the publish completeness gate. A class test
-- is teacher feedback; a term exam is an assessment of record. Different objects, different
-- lifecycles.
--
-- Absences store marks_obtained NULL and is_absent TRUE: rollups EXCLUDE them rather than score
-- them 0, because a sick child is not a failing child and attendance already answers whether
-- they were there.
CREATE TABLE "class_tests" (
  "id"            UUID NOT NULL,
  "school_id"     UUID NOT NULL,
  "section_id"    UUID NOT NULL,
  "subject_id"    UUID NOT NULL,
  "name"          TEXT NOT NULL,
  "total_marks"   DECIMAL(6,2) NOT NULL,
  "test_date"     DATE NOT NULL,
  "created_by_id" UUID,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "class_tests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "class_test_scores" (
  "id"             UUID NOT NULL,
  "school_id"      UUID NOT NULL,
  "class_test_id"  UUID NOT NULL,
  "enrollment_id"  UUID NOT NULL,
  "marks_obtained" DECIMAL(6,2),
  "is_absent"      BOOLEAN NOT NULL DEFAULT false,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "class_test_scores_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "class_tests_id_school_id_key" ON "class_tests"("id", "school_id");
CREATE INDEX "class_tests_school_id_section_id_test_date_idx" ON "class_tests"("school_id", "section_id", "test_date");
CREATE INDEX "class_tests_school_id_subject_id_test_date_idx" ON "class_tests"("school_id", "subject_id", "test_date");
CREATE INDEX "class_tests_subject_id_school_id_idx" ON "class_tests"("subject_id", "school_id");
CREATE INDEX "class_tests_created_by_id_school_id_idx" ON "class_tests"("created_by_id", "school_id");

CREATE UNIQUE INDEX "class_test_scores_class_test_id_enrollment_id_key" ON "class_test_scores"("class_test_id", "enrollment_id");
CREATE UNIQUE INDEX "class_test_scores_id_school_id_key" ON "class_test_scores"("id", "school_id");
CREATE INDEX "class_test_scores_school_id_class_test_id_idx" ON "class_test_scores"("school_id", "class_test_id");
CREATE INDEX "class_test_scores_enrollment_id_school_id_idx" ON "class_test_scores"("enrollment_id", "school_id");

-- Composite FKs carry the tenant chain (audit H-3): a child row can never point at a parent
-- belonging to another school, enforced by the database rather than by service code.
ALTER TABLE "class_tests" ADD CONSTRAINT "class_tests_school_id_fkey"
  FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "class_tests" ADD CONSTRAINT "class_tests_section_id_school_id_fkey"
  FOREIGN KEY ("section_id", "school_id") REFERENCES "sections"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "class_tests" ADD CONSTRAINT "class_tests_subject_id_school_id_fkey"
  FOREIGN KEY ("subject_id", "school_id") REFERENCES "subjects"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "class_tests" ADD CONSTRAINT "class_tests_created_by_id_school_id_fkey"
  FOREIGN KEY ("created_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "class_test_scores" ADD CONSTRAINT "class_test_scores_school_id_fkey"
  FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Cascade: a score has no meaning without its test, and deleting a test is already guarded in
-- the service (refused while scores exist), so this only fires on a genuinely empty test.
ALTER TABLE "class_test_scores" ADD CONSTRAINT "class_test_scores_class_test_id_school_id_fkey"
  FOREIGN KEY ("class_test_id", "school_id") REFERENCES "class_tests"("id", "school_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "class_test_scores" ADD CONSTRAINT "class_test_scores_enrollment_id_school_id_fkey"
  FOREIGN KEY ("enrollment_id", "school_id") REFERENCES "student_enrollments"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A mark can never be negative, and absent XOR marks is enforced in the DB as well as the
-- service, so a future writer cannot record "absent with 7 marks".
ALTER TABLE "class_tests" ADD CONSTRAINT "class_tests_total_marks_positive" CHECK ("total_marks" > 0);
ALTER TABLE "class_test_scores" ADD CONSTRAINT "class_test_scores_marks_non_negative" CHECK ("marks_obtained" IS NULL OR "marks_obtained" >= 0);
ALTER TABLE "class_test_scores" ADD CONSTRAINT "class_test_scores_absent_xor_marks"
  CHECK (("is_absent" = true AND "marks_obtained" IS NULL) OR ("is_absent" = false));
