import { Module } from '@nestjs/common';
import { StaffService } from './staff.service';
import { PayrollService } from './payroll.service';
import {
  PayrollController,
  PayslipsController,
  StaffController,
  TeacherAssignmentsController,
} from './hr.controller';

/** Staff HR & payroll (blueprint §13). */
@Module({
  controllers: [StaffController, TeacherAssignmentsController, PayrollController, PayslipsController],
  providers: [StaffService, PayrollService],
  exports: [StaffService, PayrollService],
})
export class HrModule {}
