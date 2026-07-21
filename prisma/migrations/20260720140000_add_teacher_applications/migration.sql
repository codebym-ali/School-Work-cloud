-- CreateEnum
CREATE TYPE "TeacherApplicationStatus" AS ENUM ('SUBMITTED', 'SHORTLISTED', 'REJECTED', 'HIRED');

-- AlterEnum
ALTER TYPE "EmploymentType" ADD VALUE 'VISITING';


-- CreateTable
CREATE TABLE "teacher_applications" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "campus_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "position_applied_for" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "employment_type" "EmploymentType" NOT NULL,
    "expected_salary" DECIMAL(12,2),
    "available_joining_date" DATE,
    "status" "TeacherApplicationStatus" NOT NULL DEFAULT 'SUBMITTED',
    "details" JSONB NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teacher_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "teacher_applications_school_id_status_idx" ON "teacher_applications"("school_id", "status");

-- AddForeignKey
ALTER TABLE "teacher_applications" ADD CONSTRAINT "teacher_applications_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_applications" ADD CONSTRAINT "teacher_applications_campus_id_school_id_fkey" FOREIGN KEY ("campus_id", "school_id") REFERENCES "campuses"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_applications" ADD CONSTRAINT "teacher_applications_created_by_id_school_id_fkey" FOREIGN KEY ("created_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

