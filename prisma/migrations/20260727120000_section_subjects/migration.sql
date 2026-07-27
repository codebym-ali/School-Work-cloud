-- Which subjects each SECTION studies. The class keeps the catalogue (one Subject row per
-- class+name, so exam results and reports stay single-valued); a section opts into the subset
-- it takes. Electives differ per section — 9-A Computer, 9-B Biology — while the core is shared.
-- No backfill: a section with no rows means "everything the class offers", so existing data
-- behaves exactly as before.
CREATE TABLE "section_subjects" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "school_id"  UUID NOT NULL,
  "section_id" UUID NOT NULL,
  "subject_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "section_subjects_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "section_subjects_section_id_subject_id_key" ON "section_subjects" ("section_id", "subject_id");
CREATE INDEX "section_subjects_school_id_section_id_idx" ON "section_subjects" ("school_id", "section_id");

ALTER TABLE "section_subjects"
  ADD CONSTRAINT "section_subjects_school_id_fkey"
  FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Composite FKs carry the tenant chain (audit H-3): a link can never point at a section or
-- subject belonging to another school.
ALTER TABLE "section_subjects"
  ADD CONSTRAINT "section_subjects_section_id_school_id_fkey"
  FOREIGN KEY ("section_id", "school_id") REFERENCES "sections"("id", "school_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "section_subjects"
  ADD CONSTRAINT "section_subjects_subject_id_school_id_fkey"
  FOREIGN KEY ("subject_id", "school_id") REFERENCES "subjects"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;
