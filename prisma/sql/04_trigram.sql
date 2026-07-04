-- Companion migration 04: trigram index for student name search (blueprint §17.1 item 4, §30).
CREATE INDEX IF NOT EXISTS students_full_name_trgm
  ON students USING gin (full_name gin_trgm_ops);
