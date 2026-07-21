-- Recruitment: vacancies (HR module, first slice). RLS + grants are applied to this new
-- school_id table automatically by the SQL companions (05_rls.sql loop / 06_grants.sql).

-- CreateEnum
CREATE TYPE "VacancyStatus" AS ENUM ('OPEN', 'ON_HOLD', 'CLOSED');

-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('FULL_TIME', 'PART_TIME', 'CONTRACT');

-- CreateTable
CREATE TABLE "vacancies" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "campus_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "employment_type" "EmploymentType" NOT NULL,
    "positions" INTEGER NOT NULL DEFAULT 1,
    "status" "VacancyStatus" NOT NULL DEFAULT 'OPEN',
    "created_by_id" UUID NOT NULL,
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vacancies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vacancies_school_id_status_idx" ON "vacancies"("school_id", "status");

-- AddForeignKey
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_campus_id_school_id_fkey" FOREIGN KEY ("campus_id", "school_id") REFERENCES "campuses"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_created_by_id_school_id_fkey" FOREIGN KEY ("created_by_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

