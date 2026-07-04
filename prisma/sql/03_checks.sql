-- Companion migration 03: CHECK constraints (blueprint §17.1 item 2).
-- Drop-then-add keeps this idempotent (Postgres has no ADD CONSTRAINT IF NOT EXISTS for CHECK).

-- A payment can never make paid exceed the invoice total (§12 invariant).
ALTER TABLE fee_invoices DROP CONSTRAINT IF EXISTS chk_paid_le_total;
ALTER TABLE fee_invoices
  ADD CONSTRAINT chk_paid_le_total CHECK (paid_amount <= total_amount);

-- Absent XOR marks: absent => no marks; present => marks recorded (§11).
ALTER TABLE exam_results DROP CONSTRAINT IF EXISTS chk_absent_xor_marks;
ALTER TABLE exam_results
  ADD CONSTRAINT chk_absent_xor_marks CHECK (
    (is_absent = true AND marks_obtained IS NULL)
    OR (is_absent = false AND marks_obtained IS NOT NULL)
  );

-- Leave ranges are ordered (§10).
ALTER TABLE student_leaves DROP CONSTRAINT IF EXISTS chk_student_leave_dates;
ALTER TABLE student_leaves
  ADD CONSTRAINT chk_student_leave_dates CHECK (to_date >= from_date);

ALTER TABLE staff_leaves DROP CONSTRAINT IF EXISTS chk_staff_leave_dates;
ALTER TABLE staff_leaves
  ADD CONSTRAINT chk_staff_leave_dates CHECK (to_date >= from_date);

-- Grade-scale bands are ordered (§11).
ALTER TABLE grade_scales DROP CONSTRAINT IF EXISTS chk_grade_range;
ALTER TABLE grade_scales
  ADD CONSTRAINT chk_grade_range CHECK (max_percent >= min_percent);
