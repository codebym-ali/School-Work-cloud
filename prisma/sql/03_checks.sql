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

-- ── Audit fix #7 ────────────────────────────────────────────────────────────
-- Business rules that lived only in service code. Anything writing outside those
-- services (a script, a future endpoint, a bad migration) could corrupt silently.
-- Every one below was verified against live data before being added.

-- Money is never negative (§12). fee_payments must be a real movement, not a no-op;
-- reversals are recorded in payment_reversals, not as zero/negative payments.
ALTER TABLE fee_structures DROP CONSTRAINT IF EXISTS chk_fee_structure_amount_non_negative;
ALTER TABLE fee_structures
  ADD CONSTRAINT chk_fee_structure_amount_non_negative CHECK (amount >= 0);

ALTER TABLE fee_invoices DROP CONSTRAINT IF EXISTS chk_invoice_amounts_non_negative;
ALTER TABLE fee_invoices
  ADD CONSTRAINT chk_invoice_amounts_non_negative CHECK (total_amount >= 0 AND paid_amount >= 0);

ALTER TABLE fee_payments DROP CONSTRAINT IF EXISTS chk_payment_positive;
ALTER TABLE fee_payments
  ADD CONSTRAINT chk_payment_positive CHECK (amount_paid > 0);

ALTER TABLE salary_structures DROP CONSTRAINT IF EXISTS chk_salary_basic_non_negative;
ALTER TABLE salary_structures
  ADD CONSTRAINT chk_salary_basic_non_negative CHECK (basic >= 0);

ALTER TABLE late_fee_policies DROP CONSTRAINT IF EXISTS chk_late_fee_sane;
ALTER TABLE late_fee_policies
  ADD CONSTRAINT chk_late_fee_sane CHECK (
    grace_days >= 0 AND amount >= 0 AND (max_amount IS NULL OR max_amount >= 0)
  );

-- Percentages stay within 0..100.
ALTER TABLE exam_definitions DROP CONSTRAINT IF EXISTS chk_weightage_percent_range;
ALTER TABLE exam_definitions
  ADD CONSTRAINT chk_weightage_percent_range CHECK (weightage_percent >= 0 AND weightage_percent <= 100);

ALTER TABLE report_cards DROP CONSTRAINT IF EXISTS chk_overall_percent_range;
ALTER TABLE report_cards
  ADD CONSTRAINT chk_overall_percent_range CHECK (overall_percent >= 0 AND overall_percent <= 100);

-- A PERCENT discount is a percentage; a FIXED one is an amount. Only the former is capped.
ALTER TABLE discounts DROP CONSTRAINT IF EXISTS chk_discount_value_range;
ALTER TABLE discounts
  ADD CONSTRAINT chk_discount_value_range CHECK (
    value >= 0 AND (type <> 'PERCENT' OR value <= 100)
  );

-- Structure sanity.
ALTER TABLE sections DROP CONSTRAINT IF EXISTS chk_section_capacity_positive;
ALTER TABLE sections
  ADD CONSTRAINT chk_section_capacity_positive CHECK (capacity > 0);

ALTER TABLE classes DROP CONSTRAINT IF EXISTS chk_class_order_non_negative;
ALTER TABLE classes
  ADD CONSTRAINT chk_class_order_non_negative CHECK ("order" >= 0);

ALTER TABLE classes DROP CONSTRAINT IF EXISTS chk_class_age_band;
ALTER TABLE classes
  ADD CONSTRAINT chk_class_age_band CHECK (
    min_age_years IS NULL OR max_age_years IS NULL OR max_age_years >= min_age_years
  );

-- Date ordering (mirrors checks the services already make, so they cannot be bypassed).
ALTER TABLE academic_years DROP CONSTRAINT IF EXISTS chk_academic_year_dates;
ALTER TABLE academic_years
  ADD CONSTRAINT chk_academic_year_dates CHECK (end_date > start_date);

ALTER TABLE staff_profiles DROP CONSTRAINT IF EXISTS chk_staff_employment_dates;
ALTER TABLE staff_profiles
  ADD CONSTRAINT chk_staff_employment_dates CHECK (left_at IS NULL OR left_at >= joined_at);

ALTER TABLE student_enrollments DROP CONSTRAINT IF EXISTS chk_enrollment_dates;
ALTER TABLE student_enrollments
  ADD CONSTRAINT chk_enrollment_dates CHECK (ended_at IS NULL OR ended_at >= started_at);

-- A suspension must end after it starts (StudentsService.changeStatus enforces this too).
ALTER TABLE students DROP CONSTRAINT IF EXISTS chk_student_status_window;
ALTER TABLE students
  ADD CONSTRAINT chk_student_status_window CHECK (
    status_ends_on IS NULL OR status_effective_from IS NULL OR status_ends_on > status_effective_from
  );

-- NOT segments > 0: a withheld message (unverified number) is logged with segments = 0
-- so the attempt is recorded without charging credits — see SmsService.logUnverified.
ALTER TABLE sms_logs DROP CONSTRAINT IF EXISTS chk_sms_segments_non_negative;
ALTER TABLE sms_logs
  ADD CONSTRAINT chk_sms_segments_non_negative CHECK (segments >= 0);

-- ── Bell schedule ───────────────────────────────────────────────────────────
-- Times are school-local wall clock stored as zero-padded HH:MM. The format is the reason the column
-- is text rather than `time`: zero-padded HH:MM sorts lexicographically in chronological order and
-- every other clock value in this product (attendanceMarkByTime, staffAttendance.dayStartTime) is
-- already this shape. Text without a CHECK, though, is just a string — the API validates it, and this
-- is what stops anything else from writing "8:00" or "25:61".
ALTER TABLE bell_periods DROP CONSTRAINT IF EXISTS chk_bell_period_times;
ALTER TABLE bell_periods
  ADD CONSTRAINT chk_bell_period_times CHECK (
    start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND
    end_time   ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  );

-- A day runs forwards. (The server computes both ends from a start time plus durations, so this can
-- only fire if something other than the API writes the table — which is exactly when it is wanted.)
ALTER TABLE bell_periods DROP CONSTRAINT IF EXISTS chk_bell_period_order;
ALTER TABLE bell_periods
  ADD CONSTRAINT chk_bell_period_order CHECK (end_time > start_time);

-- `period_no` and `is_teaching` are two ways of saying one thing, so they must never disagree: a
-- teaching row is numbered, a break is not. Without this the table can hold a "break" occupying
-- period 3, which renders as a lesson slot nobody can fill.
ALTER TABLE bell_periods DROP CONSTRAINT IF EXISTS chk_bell_period_teaching_numbered;
ALTER TABLE bell_periods
  ADD CONSTRAINT chk_bell_period_teaching_numbered CHECK (
    (is_teaching AND period_no IS NOT NULL) OR (NOT is_teaching AND period_no IS NULL)
  );

ALTER TABLE bell_periods DROP CONSTRAINT IF EXISTS chk_bell_period_day_of_week;
ALTER TABLE bell_periods
  ADD CONSTRAINT chk_bell_period_day_of_week CHECK (day_of_week BETWEEN 1 AND 7);

-- A subject's weekly load is a real allocation or absent — never zero-or-negative. NULL means "not
-- allocated", which is a different statement from "allocated zero", and the column keeps both.
ALTER TABLE subjects DROP CONSTRAINT IF EXISTS chk_subject_periods_per_week;
ALTER TABLE subjects
  ADD CONSTRAINT chk_subject_periods_per_week CHECK (periods_per_week IS NULL OR periods_per_week > 0);
