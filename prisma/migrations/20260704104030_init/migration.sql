-- CreateEnum
CREATE TYPE "Role" AS ENUM ('PLATFORM_ADMIN', 'OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT', 'TEACHER', 'STAFF', 'PARENT', 'STUDENT');

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('BASIC', 'PLUS', 'PRO');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER');

-- CreateEnum
CREATE TYPE "InquiryStatus" AS ENUM ('INQUIRY', 'ENTRY_TEST_SCHEDULED', 'ENTRY_TEST_PASSED', 'ENTRY_TEST_FAILED', 'ADMITTED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('ACTIVE', 'PROMOTED', 'RETAINED', 'TRANSFERRED_OUT', 'WITHDRAWN', 'COMPLETED');

-- CreateEnum
CREATE TYPE "GuardianRelation" AS ENUM ('FATHER', 'MOTHER', 'GUARDIAN');

-- CreateEnum
CREATE TYPE "FeeFrequency" AS ENUM ('MONTHLY', 'ANNUAL', 'ONE_TIME', 'ADMISSION');

-- CreateEnum
CREATE TYPE "FeeInvoiceStatus" AS ENUM ('PENDING', 'PARTIAL', 'PAID', 'OVERDUE', 'WAIVED');

-- CreateEnum
CREATE TYPE "InvoiceItemType" AS ENUM ('FEE', 'DISCOUNT', 'FINE', 'WAIVER');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'EASYPAISA', 'JAZZCASH', 'CARD', 'CHEQUE');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'LATE', 'HALF_DAY', 'ON_LEAVE');

-- CreateEnum
CREATE TYPE "AttendanceSession" AS ENUM ('MORNING', 'EVENING');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StaffLeaveType" AS ENUM ('CASUAL', 'SICK', 'UNPAID', 'OTHER');

-- CreateEnum
CREATE TYPE "ExamType" AS ENUM ('MONTHLY', 'MID_TERM', 'FINAL', 'SURPRISE_TEST');

-- CreateEnum
CREATE TYPE "ExamStatus" AS ENUM ('DRAFT', 'MARKS_ENTRY', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "SmsStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "StaffType" AS ENUM ('TEACHER', 'ADMIN', 'ACCOUNTANT', 'CLERK', 'SUPPORT');

-- CreateEnum
CREATE TYPE "EmploymentStatus" AS ENUM ('ACTIVE', 'ON_LEAVE', 'TERMINATED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('LEAVING_CERT', 'CHARACTER_CERT', 'FEE_CLEARANCE', 'REPORT_CARD', 'PAYSLIP', 'RECEIPT');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'LOCKED', 'DISABLED');

-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'APPROVED');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENT', 'FIXED');

-- CreateEnum
CREATE TYPE "DiscountStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateTable
CREATE TABLE "schools" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "subdomain" TEXT NOT NULL,
    "custom_domain" TEXT,
    "plan_tier" "PlanTier" NOT NULL DEFAULT 'BASIC',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "suspended_at" TIMESTAMP(3),
    "gr_number_mode" TEXT NOT NULL DEFAULT 'AUTO',
    "gr_prefix" TEXT NOT NULL DEFAULT '',
    "next_gr_number" INTEGER NOT NULL DEFAULT 1,
    "next_receipt_no" INTEGER NOT NULL DEFAULT 1,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campuses" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academic_years" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "academic_years_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classes" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "campus_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "min_age_years" INTEGER,
    "max_age_years" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sections" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 40,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subjects" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "campus_id" UUID,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "campus_id" UUID,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "password_hash" TEXT,
    "roles" "Role"[],
    "status" "UserStatus" NOT NULL DEFAULT 'INVITED',
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "mfa_secret_enc" TEXT,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "password_changed_at" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parent_profiles" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "phone_verified_at" TIMESTAMP(3),
    "sms_opt_out" BOOLEAN NOT NULL DEFAULT false,
    "cnic_enc" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parent_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "students" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "user_id" UUID,
    "gr_number" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "gender" "Gender" NOT NULL,
    "date_of_birth" DATE NOT NULL,
    "photo_key" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "deleted_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_guardians" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "parent_id" UUID NOT NULL,
    "relation" "GuardianRelation" NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "student_guardians_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_enrollments" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "campus_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "roll_number" INTEGER,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_profiles" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "staff_type" "StaffType" NOT NULL,
    "employee_code" TEXT NOT NULL,
    "designation" TEXT NOT NULL,
    "employment_status" "EmploymentStatus" NOT NULL DEFAULT 'ACTIVE',
    "joined_at" DATE NOT NULL,
    "left_at" DATE,
    "bank_account_enc" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teacher_assignments" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "subject_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teacher_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inquiries" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "campus_id" UUID NOT NULL,
    "guardian_name" TEXT NOT NULL,
    "guardian_phone" TEXT NOT NULL,
    "student_name" TEXT NOT NULL,
    "desired_class_id" UUID NOT NULL,
    "status" "InquiryStatus" NOT NULL DEFAULT 'INQUIRY',
    "status_reason" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inquiries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entry_tests" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "inquiry_id" UUID NOT NULL,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "score" DECIMAL(5,2),
    "remarks" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entry_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admissions" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "inquiry_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "admitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "admitted_by_id" UUID NOT NULL,

    CONSTRAINT "admissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_heads" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "fee_heads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_structures" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "campus_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "fee_head_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "frequency" "FeeFrequency" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fee_structures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_invoice_batches" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_invoice_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_invoices" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "batch_id" UUID,
    "total_amount" DECIMAL(12,2) NOT NULL,
    "paid_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "due_date" DATE NOT NULL,
    "status" "FeeInvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "month" INTEGER,
    "year" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fee_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_invoice_items" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "type" "InvoiceItemType" NOT NULL DEFAULT 'FEE',
    "fee_head_id" UUID,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "fee_invoice_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_payments" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "receipt_no" INTEGER NOT NULL,
    "amount_paid" DECIMAL(12,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "transaction_ref" TEXT,
    "collected_by_id" UUID NOT NULL,
    "paid_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_reversals" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "receipt_no" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "approved_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_reversals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discounts" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "type" "DiscountType" NOT NULL,
    "value" DECIMAL(12,2) NOT NULL,
    "fee_head_id" UUID,
    "reason" TEXT NOT NULL,
    "status" "DiscountStatus" NOT NULL DEFAULT 'ACTIVE',
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "approved_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "late_fee_policies" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "grace_days" INTEGER NOT NULL DEFAULT 0,
    "mode" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "max_amount" DECIMAL(12,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "late_fee_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guardian_credits" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "parent_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guardian_credits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_records" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "session" "AttendanceSession" NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "marked_by_id" UUID NOT NULL,
    "locked_by_leave_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_attendance" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "session" "AttendanceSession" NOT NULL DEFAULT 'MORNING',
    "status" "AttendanceStatus" NOT NULL,
    "check_in" TIMESTAMP(3),
    "check_out" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_leaves" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "rejection_reason" TEXT,
    "requested_by_id" UUID NOT NULL,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_leaves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_leaves" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "leave_type" "StaffLeaveType" NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "is_unpaid" BOOLEAN NOT NULL DEFAULT false,
    "rejection_reason" TEXT,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_leaves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grade_scales" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "min_percent" DECIMAL(5,2) NOT NULL,
    "max_percent" DECIMAL(5,2) NOT NULL,
    "grade_point" DECIMAL(3,1) NOT NULL,

    CONSTRAINT "grade_scales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terms" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,

    CONSTRAINT "terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_definitions" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "term_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "exam_type" "ExamType" NOT NULL,
    "weightage_percent" DECIMAL(5,2) NOT NULL,
    "exam_date" DATE NOT NULL,
    "status" "ExamStatus" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMP(3),
    "published_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exam_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_results" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "exam_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "marks_obtained" DECIMAL(6,2),
    "total_marks" DECIMAL(6,2) NOT NULL,
    "is_absent" BOOLEAN NOT NULL DEFAULT false,
    "entered_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exam_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_cards" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "term_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "overall_percent" DECIMAL(5,2) NOT NULL,
    "grade_label" TEXT NOT NULL,
    "section_rank" INTEGER,
    "document_id" UUID,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetable_slots" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "period_no" INTEGER NOT NULL,
    "subject_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,

    CONSTRAINT "timetable_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_structures" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "basic" DECIMAL(12,2) NOT NULL,
    "allowances" JSONB NOT NULL DEFAULT '{}',
    "fixed_deductions" JSONB NOT NULL DEFAULT '{}',
    "effective_from" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salary_structures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "campus_id" UUID NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "approved_by_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslips" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "gross" DECIMAL(12,2) NOT NULL,
    "attendance_deduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "other_deductions" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "net_pay" DECIMAL(12,2) NOT NULL,
    "breakdown" JSONB NOT NULL,
    "paid_at" TIMESTAMP(3),
    "payment_method" "PaymentMethod",
    "payment_ref" TEXT,

    CONSTRAINT "payslips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_templates" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "trigger_key" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_logs" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "recipient" TEXT NOT NULL,
    "student_id" UUID,
    "user_id" UUID,
    "invoice_id" UUID,
    "template_key" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "segments" INTEGER NOT NULL DEFAULT 1,
    "status" "SmsStatus" NOT NULL DEFAULT 'QUEUED',
    "gateway_message_id" TEXT,
    "fail_reason" TEXT,
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_credit_ledger" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "delta" INTEGER NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "student_id" UUID,
    "staff_id" UUID,
    "type" "DocumentType" NOT NULL,
    "file_key" TEXT NOT NULL,
    "issued_by_id" UUID NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "old_value" JSONB,
    "new_value" JSONB,
    "reason" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_code" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "schools_subdomain_key" ON "schools"("subdomain");

-- CreateIndex
CREATE UNIQUE INDEX "schools_custom_domain_key" ON "schools"("custom_domain");

-- CreateIndex
CREATE UNIQUE INDEX "campuses_id_school_id_key" ON "campuses"("id", "school_id");

-- CreateIndex
CREATE UNIQUE INDEX "campuses_school_id_name_key" ON "campuses"("school_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "academic_years_id_school_id_key" ON "academic_years"("id", "school_id");

-- CreateIndex
CREATE UNIQUE INDEX "academic_years_school_id_name_key" ON "academic_years"("school_id", "name");

-- CreateIndex
CREATE INDEX "classes_school_id_campus_id_idx" ON "classes"("school_id", "campus_id");

-- CreateIndex
CREATE UNIQUE INDEX "classes_id_school_id_key" ON "classes"("id", "school_id");

-- CreateIndex
CREATE UNIQUE INDEX "classes_campus_id_name_key" ON "classes"("campus_id", "name");

-- CreateIndex
CREATE INDEX "sections_school_id_class_id_idx" ON "sections"("school_id", "class_id");

-- CreateIndex
CREATE UNIQUE INDEX "sections_id_school_id_key" ON "sections"("id", "school_id");

-- CreateIndex
CREATE UNIQUE INDEX "sections_class_id_name_key" ON "sections"("class_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "subjects_id_school_id_key" ON "subjects"("id", "school_id");

-- CreateIndex
CREATE UNIQUE INDEX "subjects_class_id_name_key" ON "subjects"("class_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "holidays_school_id_date_campus_id_key" ON "holidays"("school_id", "date", "campus_id");

-- CreateIndex
CREATE INDEX "users_school_idx" ON "users"("school_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_id_school_id_key" ON "users"("id", "school_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_school_id_email_key" ON "users"("school_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_family_id_idx" ON "refresh_tokens"("user_id", "family_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "parent_profiles_school_id_phone_idx" ON "parent_profiles"("school_id", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "parent_profiles_id_school_id_key" ON "parent_profiles"("id", "school_id");

-- CreateIndex
CREATE UNIQUE INDEX "parent_profiles_user_id_key" ON "parent_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "parent_profiles_user_id_school_id_key" ON "parent_profiles"("user_id", "school_id");

-- CreateIndex
CREATE UNIQUE INDEX "students_user_id_key" ON "students"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "students_id_school_id_key" ON "students"("id", "school_id");

-- CreateIndex
CREATE UNIQUE INDEX "students_school_id_gr_number_key" ON "students"("school_id", "gr_number");

-- CreateIndex
CREATE UNIQUE INDEX "students_user_id_school_id_key" ON "students"("user_id", "school_id");

-- CreateIndex
CREATE INDEX "student_guardians_school_id_parent_id_idx" ON "student_guardians"("school_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_guardians_student_id_parent_id_key" ON "student_guardians"("student_id", "parent_id");

-- CreateIndex
CREATE INDEX "student_enrollments_school_id_academic_year_id_section_id_s_idx" ON "student_enrollments"("school_id", "academic_year_id", "section_id", "status");

-- CreateIndex
CREATE INDEX "student_enrollments_student_id_idx" ON "student_enrollments"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_enrollments_id_school_id_key" ON "student_enrollments"("id", "school_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_enrollments_section_id_academic_year_id_roll_number_key" ON "student_enrollments"("section_id", "academic_year_id", "roll_number");

-- CreateIndex
CREATE UNIQUE INDEX "staff_profiles_user_id_key" ON "staff_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_profiles_id_school_id_key" ON "staff_profiles"("id", "school_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_profiles_school_id_employee_code_key" ON "staff_profiles"("school_id", "employee_code");

-- CreateIndex
CREATE UNIQUE INDEX "staff_profiles_user_id_school_id_key" ON "staff_profiles"("user_id", "school_id");

-- CreateIndex
CREATE INDEX "teacher_assignments_school_id_academic_year_id_section_id_idx" ON "teacher_assignments"("school_id", "academic_year_id", "section_id");

-- CreateIndex
CREATE UNIQUE INDEX "teacher_assignments_staff_id_academic_year_id_section_id_su_key" ON "teacher_assignments"("staff_id", "academic_year_id", "section_id", "subject_id");

-- CreateIndex
CREATE INDEX "inquiries_school_id_campus_id_status_idx" ON "inquiries"("school_id", "campus_id", "status");

-- CreateIndex
CREATE INDEX "inquiries_school_id_guardian_phone_idx" ON "inquiries"("school_id", "guardian_phone");

-- CreateIndex
CREATE UNIQUE INDEX "inquiries_id_school_id_key" ON "inquiries"("id", "school_id");

-- CreateIndex
CREATE UNIQUE INDEX "entry_tests_inquiry_id_key" ON "entry_tests"("inquiry_id");

-- CreateIndex
CREATE UNIQUE INDEX "entry_tests_inquiry_id_school_id_key" ON "entry_tests"("inquiry_id", "school_id");

-- CreateIndex
CREATE UNIQUE INDEX "admissions_inquiry_id_key" ON "admissions"("inquiry_id");

-- CreateIndex
CREATE UNIQUE INDEX "admissions_student_id_key" ON "admissions"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "admissions_inquiry_id_school_id_key" ON "admissions"("inquiry_id", "school_id");

-- CreateIndex
CREATE UNIQUE INDEX "admissions_student_id_school_id_key" ON "admissions"("student_id", "school_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_heads_id_school_id_key" ON "fee_heads"("id", "school_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_heads_school_id_name_key" ON "fee_heads"("school_id", "name");

-- CreateIndex
CREATE INDEX "fee_structures_school_id_campus_id_class_id_idx" ON "fee_structures"("school_id", "campus_id", "class_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_structures_class_id_fee_head_id_academic_year_id_freque_key" ON "fee_structures"("class_id", "fee_head_id", "academic_year_id", "frequency");

-- CreateIndex
CREATE UNIQUE INDEX "fee_invoice_batches_school_id_class_id_month_year_key" ON "fee_invoice_batches"("school_id", "class_id", "month", "year");

-- CreateIndex
CREATE INDEX "fee_invoices_school_id_student_id_status_idx" ON "fee_invoices"("school_id", "student_id", "status");

-- CreateIndex
CREATE INDEX "fee_invoices_school_id_status_due_date_idx" ON "fee_invoices"("school_id", "status", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "fee_invoices_id_school_id_key" ON "fee_invoices"("id", "school_id");

-- CreateIndex
CREATE INDEX "fee_invoice_items_invoice_id_idx" ON "fee_invoice_items"("invoice_id");

-- CreateIndex
CREATE INDEX "fee_payments_school_id_paid_at_idx" ON "fee_payments"("school_id", "paid_at");

-- CreateIndex
CREATE UNIQUE INDEX "fee_payments_id_school_id_key" ON "fee_payments"("id", "school_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_payments_school_id_receipt_no_key" ON "fee_payments"("school_id", "receipt_no");

-- CreateIndex
CREATE UNIQUE INDEX "payment_reversals_payment_id_key" ON "payment_reversals"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_reversals_school_id_receipt_no_key" ON "payment_reversals"("school_id", "receipt_no");

-- CreateIndex
CREATE UNIQUE INDEX "payment_reversals_payment_id_school_id_key" ON "payment_reversals"("payment_id", "school_id");

-- CreateIndex
CREATE INDEX "discounts_school_id_student_id_status_idx" ON "discounts"("school_id", "student_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "late_fee_policies_school_id_key" ON "late_fee_policies"("school_id");

-- CreateIndex
CREATE INDEX "guardian_credits_school_id_parent_id_idx" ON "guardian_credits"("school_id", "parent_id");

-- CreateIndex
CREATE INDEX "attendance_records_school_id_date_idx" ON "attendance_records"("school_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_records_enrollment_id_date_session_key" ON "attendance_records"("enrollment_id", "date", "session");

-- CreateIndex
CREATE INDEX "staff_attendance_school_id_date_idx" ON "staff_attendance"("school_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "staff_attendance_staff_id_date_session_key" ON "staff_attendance"("staff_id", "date", "session");

-- CreateIndex
CREATE INDEX "student_leaves_school_id_status_idx" ON "student_leaves"("school_id", "status");

-- CreateIndex
CREATE INDEX "student_leaves_student_id_from_date_to_date_idx" ON "student_leaves"("student_id", "from_date", "to_date");

-- CreateIndex
CREATE INDEX "staff_leaves_school_id_status_idx" ON "staff_leaves"("school_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "grade_scales_school_id_academic_year_id_label_key" ON "grade_scales"("school_id", "academic_year_id", "label");

-- CreateIndex
CREATE UNIQUE INDEX "terms_id_school_id_key" ON "terms"("id", "school_id");

-- CreateIndex
CREATE UNIQUE INDEX "terms_academic_year_id_name_key" ON "terms"("academic_year_id", "name");

-- CreateIndex
CREATE INDEX "exam_definitions_school_id_class_id_term_id_idx" ON "exam_definitions"("school_id", "class_id", "term_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_definitions_id_school_id_key" ON "exam_definitions"("id", "school_id");

-- CreateIndex
CREATE INDEX "exam_results_school_id_enrollment_id_idx" ON "exam_results"("school_id", "enrollment_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_results_exam_id_enrollment_id_subject_id_key" ON "exam_results"("exam_id", "enrollment_id", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "report_cards_term_id_enrollment_id_key" ON "report_cards"("term_id", "enrollment_id");

-- CreateIndex
CREATE INDEX "timetable_slots_school_id_staff_id_day_of_week_idx" ON "timetable_slots"("school_id", "staff_id", "day_of_week");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_slots_section_id_academic_year_id_day_of_week_per_key" ON "timetable_slots"("section_id", "academic_year_id", "day_of_week", "period_no");

-- CreateIndex
CREATE INDEX "salary_structures_school_id_staff_id_effective_from_idx" ON "salary_structures"("school_id", "staff_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_id_school_id_key" ON "payroll_runs"("id", "school_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_school_id_campus_id_month_year_key" ON "payroll_runs"("school_id", "campus_id", "month", "year");

-- CreateIndex
CREATE INDEX "payslips_school_id_staff_id_idx" ON "payslips"("school_id", "staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_run_id_staff_id_key" ON "payslips"("run_id", "staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "sms_templates_school_id_trigger_key_key" ON "sms_templates"("school_id", "trigger_key");

-- CreateIndex
CREATE INDEX "sms_logs_school_id_status_idx" ON "sms_logs"("school_id", "status");

-- CreateIndex
CREATE INDEX "sms_logs_school_id_created_at_idx" ON "sms_logs"("school_id", "created_at");

-- CreateIndex
CREATE INDEX "sms_logs_gateway_message_id_idx" ON "sms_logs"("gateway_message_id");

-- CreateIndex
CREATE INDEX "sms_credit_ledger_school_id_created_at_idx" ON "sms_credit_ledger"("school_id", "created_at");

-- CreateIndex
CREATE INDEX "documents_school_id_student_id_idx" ON "documents"("school_id", "student_id");

-- CreateIndex
CREATE INDEX "audit_logs_school_id_created_at_idx" ON "audit_logs"("school_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_school_id_user_id_idx" ON "audit_logs"("school_id", "user_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_school_id_key_key" ON "idempotency_keys"("school_id", "key");

-- AddForeignKey
ALTER TABLE "campuses" ADD CONSTRAINT "campuses_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academic_years" ADD CONSTRAINT "academic_years_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classes" ADD CONSTRAINT "classes_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classes" ADD CONSTRAINT "classes_campus_id_school_id_fkey" FOREIGN KEY ("campus_id", "school_id") REFERENCES "campuses"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_class_id_school_id_fkey" FOREIGN KEY ("class_id", "school_id") REFERENCES "classes"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_class_id_school_id_fkey" FOREIGN KEY ("class_id", "school_id") REFERENCES "classes"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_campus_id_school_id_fkey" FOREIGN KEY ("campus_id", "school_id") REFERENCES "campuses"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_school_id_fkey" FOREIGN KEY ("user_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parent_profiles" ADD CONSTRAINT "parent_profiles_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parent_profiles" ADD CONSTRAINT "parent_profiles_user_id_school_id_fkey" FOREIGN KEY ("user_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_user_id_school_id_fkey" FOREIGN KEY ("user_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_student_id_school_id_fkey" FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_parent_id_school_id_fkey" FOREIGN KEY ("parent_id", "school_id") REFERENCES "parent_profiles"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_enrollments" ADD CONSTRAINT "student_enrollments_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_enrollments" ADD CONSTRAINT "student_enrollments_student_id_school_id_fkey" FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_enrollments" ADD CONSTRAINT "student_enrollments_academic_year_id_school_id_fkey" FOREIGN KEY ("academic_year_id", "school_id") REFERENCES "academic_years"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_enrollments" ADD CONSTRAINT "student_enrollments_section_id_school_id_fkey" FOREIGN KEY ("section_id", "school_id") REFERENCES "sections"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_user_id_school_id_fkey" FOREIGN KEY ("user_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_staff_id_school_id_fkey" FOREIGN KEY ("staff_id", "school_id") REFERENCES "staff_profiles"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_campus_id_school_id_fkey" FOREIGN KEY ("campus_id", "school_id") REFERENCES "campuses"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_tests" ADD CONSTRAINT "entry_tests_inquiry_id_school_id_fkey" FOREIGN KEY ("inquiry_id", "school_id") REFERENCES "inquiries"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_inquiry_id_school_id_fkey" FOREIGN KEY ("inquiry_id", "school_id") REFERENCES "inquiries"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_student_id_school_id_fkey" FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_heads" ADD CONSTRAINT "fee_heads_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_class_id_school_id_fkey" FOREIGN KEY ("class_id", "school_id") REFERENCES "classes"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_fee_head_id_school_id_fkey" FOREIGN KEY ("fee_head_id", "school_id") REFERENCES "fee_heads"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_invoice_batches" ADD CONSTRAINT "fee_invoice_batches_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_invoices" ADD CONSTRAINT "fee_invoices_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_invoices" ADD CONSTRAINT "fee_invoices_student_id_school_id_fkey" FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_invoices" ADD CONSTRAINT "fee_invoices_enrollment_id_school_id_fkey" FOREIGN KEY ("enrollment_id", "school_id") REFERENCES "student_enrollments"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_invoice_items" ADD CONSTRAINT "fee_invoice_items_invoice_id_school_id_fkey" FOREIGN KEY ("invoice_id", "school_id") REFERENCES "fee_invoices"("id", "school_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_invoice_id_school_id_fkey" FOREIGN KEY ("invoice_id", "school_id") REFERENCES "fee_invoices"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_collected_by_id_school_id_fkey" FOREIGN KEY ("collected_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_payment_id_school_id_fkey" FOREIGN KEY ("payment_id", "school_id") REFERENCES "fee_payments"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_student_id_school_id_fkey" FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_approved_by_id_school_id_fkey" FOREIGN KEY ("approved_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "late_fee_policies" ADD CONSTRAINT "late_fee_policies_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_enrollment_id_school_id_fkey" FOREIGN KEY ("enrollment_id", "school_id") REFERENCES "student_enrollments"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_marked_by_id_school_id_fkey" FOREIGN KEY ("marked_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_staff_id_school_id_fkey" FOREIGN KEY ("staff_id", "school_id") REFERENCES "staff_profiles"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_leaves" ADD CONSTRAINT "student_leaves_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_leaves" ADD CONSTRAINT "student_leaves_student_id_school_id_fkey" FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_leaves" ADD CONSTRAINT "staff_leaves_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_leaves" ADD CONSTRAINT "staff_leaves_staff_id_school_id_fkey" FOREIGN KEY ("staff_id", "school_id") REFERENCES "staff_profiles"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_scales" ADD CONSTRAINT "grade_scales_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terms" ADD CONSTRAINT "terms_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terms" ADD CONSTRAINT "terms_academic_year_id_school_id_fkey" FOREIGN KEY ("academic_year_id", "school_id") REFERENCES "academic_years"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_definitions" ADD CONSTRAINT "exam_definitions_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_definitions" ADD CONSTRAINT "exam_definitions_term_id_school_id_fkey" FOREIGN KEY ("term_id", "school_id") REFERENCES "terms"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_definitions" ADD CONSTRAINT "exam_definitions_class_id_school_id_fkey" FOREIGN KEY ("class_id", "school_id") REFERENCES "classes"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_exam_id_school_id_fkey" FOREIGN KEY ("exam_id", "school_id") REFERENCES "exam_definitions"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_enrollment_id_school_id_fkey" FOREIGN KEY ("enrollment_id", "school_id") REFERENCES "student_enrollments"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_subject_id_school_id_fkey" FOREIGN KEY ("subject_id", "school_id") REFERENCES "subjects"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_structures" ADD CONSTRAINT "salary_structures_staff_id_school_id_fkey" FOREIGN KEY ("staff_id", "school_id") REFERENCES "staff_profiles"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_run_id_school_id_fkey" FOREIGN KEY ("run_id", "school_id") REFERENCES "payroll_runs"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_staff_id_school_id_fkey" FOREIGN KEY ("staff_id", "school_id") REFERENCES "staff_profiles"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_templates" ADD CONSTRAINT "sms_templates_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_logs" ADD CONSTRAINT "sms_logs_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
