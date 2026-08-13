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

-- One invoice per (student, month, year) — idempotent generation (§12).
--
-- â  **This used to be `WHERE batch_id IS NOT NULL`, and that gap was about to be walked into.**
-- It constrained only invoices a BATCH created, so the moment a per-student path existed
-- (Fees Billing Plan, B1) the same child could be billed twice for one month -- once by the batch,
-- once ad hoc -- and the database would not have objected. For money a read-then-write check in a
-- service is not a constraint: two requests both pass it. The service check makes the refusal
-- civil; this index is what makes it true.
--
-- Predicated on `month IS NOT NULL` rather than left unconditional, because that is honest about
-- what it enforces: **Postgres treats NULLs as DISTINCT**, so rows with no month would slip past an
-- unconditional index anyway and the WHERE clause says so out loud rather than implying cover it
-- does not give. (The same behaviour `fee_invoices.psid` deliberately relies on, three indexes
-- down.) A periodic invoice always carries a month -- charge-once items ride on one rather than
-- inventing month-less invoices.
DROP INDEX IF EXISTS fee_invoices_one_batch_per_student_month;
CREATE UNIQUE INDEX IF NOT EXISTS fee_invoices_one_per_student_month
  ON fee_invoices (school_id, student_id, month, year)
  WHERE month IS NOT NULL;

-- Non-cash payments: unique transaction reference per (school, method) (§12).
CREATE UNIQUE INDEX IF NOT EXISTS fee_payments_unique_txn_ref
  ON fee_payments (school_id, method, transaction_ref)
  WHERE transaction_ref IS NOT NULL;

-- Identity that a REMOVED record must not keep holding (§17.1, audit fix #3).
-- A plain UNIQUE spans soft-deleted rows, so a departed teacher owned their email for ever
-- and a mis-keyed admission owned its GR number for ever. Deleting means "this should never
-- have existed" — softDelete refuses once fees or certificates are attached — so only
-- mistakes free their identifier. A WITHDRAWN or STRUCK_OFF student is not deleted and
-- keeps their GR number, which is what a school register requires.
CREATE UNIQUE INDEX IF NOT EXISTS users_one_live_email_per_school
  ON users (school_id, email)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS students_one_live_gr_number_per_school
  ON students (school_id, gr_number)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS students_one_live_registration_no_per_school
  ON students (school_id, registration_no)
  WHERE deleted_at IS NULL;

-- One holder per campus "seat" role (§23). A campus has exactly one principal and exactly
-- one admission officer: both speak for the campus, so a second holder makes "who is
-- responsible for this campus?" unanswerable, and for admissions it also means two people
-- minting GR numbers into the same register.
--
-- UsersService.assertSoleCampusSeat already checks this on create/update/grant, but a check
-- is read-then-write: two owners assigning at the same moment can both pass it. These
-- indexes make the DB itself refuse the second holder, so the rule holds under a race.
-- Partial on `deleted_at IS NULL` so a REMOVED holder frees the seat immediately (a
-- departed admission officer must not keep their campus's seat locked for ever).
CREATE UNIQUE INDEX IF NOT EXISTS users_one_campus_admin_per_campus
  ON users (campus_id)
  WHERE 'CAMPUS_ADMIN' = ANY (roles) AND deleted_at IS NULL AND campus_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_one_admission_controller_per_campus
  ON users (campus_id)
  WHERE 'ADMISSION_CONTROLLER' = ANY (roles) AND deleted_at IS NULL AND campus_id IS NOT NULL;

-- The accountant is the third seat (operator instruction, 2026-08-12): one person per campus
-- reconciles the drawer, so a shortfall has one name against it.
--
-- â  This index is stricter than the service check in one way that matters on an EXISTING
-- tenant: `assertSoleCampusSeat` only runs on a write, so a school that already has two
-- accountants on one campus keeps them until somebody edits one -- but THIS statement fails
-- outright while they both exist, taking `db:setup` down with it. That is the intended order of
-- events: a duplicate seat is resolved deliberately by a human, not silently by a migration
-- picking a winner.
CREATE UNIQUE INDEX IF NOT EXISTS users_one_accountant_per_campus
  ON users (campus_id)
  WHERE 'ACCOUNTANT' = ANY (roles) AND deleted_at IS NULL AND campus_id IS NOT NULL;

-- Cover: one owner per class, per period — or per day when the school runs no timetable.
--
-- Two PARTIAL indexes rather than one `UNIQUE (section_id, date, period_no)`, because
-- `period_no` is nullable and **Postgres treats NULLs as DISTINCT**: a plain unique index
-- would happily accept two whole-day covers for the same section on the same date, which is
-- precisely what it would exist to prevent. (Same behaviour `fee_invoices.psid` relies on
-- deliberately, a few lines from here — it is a tool, and it cuts both ways.)
CREATE UNIQUE INDEX IF NOT EXISTS cover_one_per_section_period
  ON cover_assignments (school_id, section_id, date, period_no)
  WHERE period_no IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cover_one_per_section_day
  ON cover_assignments (school_id, section_id, date)
  WHERE period_no IS NULL;
