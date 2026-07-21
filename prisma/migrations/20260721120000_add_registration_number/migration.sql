
-- AlterTable
ALTER TABLE "schools" ADD COLUMN     "next_registration_no" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "registration_no_mode" TEXT NOT NULL DEFAULT 'AUTO',
ADD COLUMN     "registration_prefix" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "students" ADD COLUMN     "registration_no" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "students_school_id_registration_no_key" ON "students"("school_id", "registration_no");

