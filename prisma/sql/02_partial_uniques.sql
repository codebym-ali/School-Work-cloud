-- Companion migration 02: partial unique indexes (blueprint §17.1 item 1).
-- These enforce invariants Prisma's @@unique cannot express (WHERE clauses).

-- Exactly one current academic year per school (§7).
CREATE UNIQUE INDEX IF NOT EXISTS academic_years_one_current_per_school
  ON academic_years (school_id)
  WHERE is_current = true;

-- Exactly one primary guardian per student (§8.3).
CREATE UNIQUE INDEX IF NOT EXISTS student_guardians_one_primary_per_student
  ON student_guardians (student_id)
  WHERE is_primary = true;

-- One ACTIVE enrollment per student per academic year (§7).
CREATE UNIQUE INDEX IF NOT EXISTS student_enrollments_one_active_per_year
  ON student_enrollments (student_id, academic_year_id)
  WHERE status = 'ACTIVE';

-- One batch-generated invoice per (student, month, year) — idempotent generation (§12).
CREATE UNIQUE INDEX IF NOT EXISTS fee_invoices_one_batch_per_student_month
  ON fee_invoices (school_id, student_id, month, year)
  WHERE batch_id IS NOT NULL;

-- Non-cash payments: unique transaction reference per (school, method) (§12).
CREATE UNIQUE INDEX IF NOT EXISTS fee_payments_unique_txn_ref
  ON fee_payments (school_id, method, transaction_ref)
  WHERE transaction_ref IS NOT NULL;
