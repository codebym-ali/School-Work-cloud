-- CreateTable
CREATE TABLE "bell_schedules" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "campus_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bell_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bell_schedule_classes" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bell_schedule_classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bell_periods" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "is_teaching" BOOLEAN NOT NULL,
    "period_no" INTEGER,
    "label" VARCHAR(30),
    "start_time" VARCHAR(5) NOT NULL,
    "end_time" VARCHAR(5) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bell_periods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bell_schedules_school_id_campus_id_academic_year_id_idx" ON "bell_schedules"("school_id", "campus_id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "bell_schedules_id_school_id_key" ON "bell_schedules"("id", "school_id");

-- CreateIndex
CREATE INDEX "bell_schedule_classes_school_id_schedule_id_idx" ON "bell_schedule_classes"("school_id", "schedule_id");

-- CreateIndex
CREATE INDEX "bell_schedule_classes_class_id_school_id_idx" ON "bell_schedule_classes"("class_id", "school_id");

-- CreateIndex
CREATE UNIQUE INDEX "bell_schedule_classes_class_id_schedule_id_key" ON "bell_schedule_classes"("class_id", "schedule_id");

-- CreateIndex
CREATE INDEX "bell_periods_school_id_schedule_id_day_of_week_idx" ON "bell_periods"("school_id", "schedule_id", "day_of_week");

-- CreateIndex
CREATE UNIQUE INDEX "bell_periods_schedule_id_day_of_week_sequence_key" ON "bell_periods"("schedule_id", "day_of_week", "sequence");

-- AddForeignKey
ALTER TABLE "bell_schedules" ADD CONSTRAINT "bell_schedules_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bell_schedules" ADD CONSTRAINT "bell_schedules_campus_id_school_id_fkey" FOREIGN KEY ("campus_id", "school_id") REFERENCES "campuses"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bell_schedules" ADD CONSTRAINT "bell_schedules_academic_year_id_school_id_fkey" FOREIGN KEY ("academic_year_id", "school_id") REFERENCES "academic_years"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bell_schedule_classes" ADD CONSTRAINT "bell_schedule_classes_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bell_schedule_classes" ADD CONSTRAINT "bell_schedule_classes_schedule_id_school_id_fkey" FOREIGN KEY ("schedule_id", "school_id") REFERENCES "bell_schedules"("id", "school_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bell_schedule_classes" ADD CONSTRAINT "bell_schedule_classes_class_id_school_id_fkey" FOREIGN KEY ("class_id", "school_id") REFERENCES "classes"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bell_periods" ADD CONSTRAINT "bell_periods_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bell_periods" ADD CONSTRAINT "bell_periods_schedule_id_school_id_fkey" FOREIGN KEY ("schedule_id", "school_id") REFERENCES "bell_schedules"("id", "school_id") ON DELETE CASCADE ON UPDATE CASCADE;

