import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { StaffService } from './staff.service';
import { PayrollService } from './payroll.service';
import { RecruitmentService } from './recruitment.service';
import { TeacherApplicationsService } from './teacher-applications.service';
import {
  PayrollController,
  PayslipsController,
  StaffController,
  TeacherAssignmentsController,
} from './hr.controller';
import { VacanciesController } from './recruitment.controller';
import { TeacherApplicationsController } from './teacher-applications.controller';

/** Staff HR, payroll & recruitment (blueprint §13). */
@Module({
  imports: [AccessModule],
  controllers: [StaffController, TeacherAssignmentsController, PayrollController, PayslipsController, VacanciesController, TeacherApplicationsController],
  providers: [StaffService, PayrollService, RecruitmentService, TeacherApplicationsService],
  exports: [StaffService, PayrollService, RecruitmentService, TeacherApplicationsService],
})
export class HrModule {}
