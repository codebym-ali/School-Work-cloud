import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { AuthModule } from '../auth/auth.module';
import { StaffService } from './staff.service';
import { PayrollService } from './payroll.service';
import {
  PayrollController,
  PayslipsController,
  StaffController,
  TeacherAssignmentsController,
} from './hr.controller';

/**
 * Staff records & payroll (blueprint §13).
 *
 * Recruitment was removed (2026-07-30): hiring happens offline — interviews, references and the
 * decision — so a vacancy board and an applicant pipeline were process theatre with nothing
 * downstream depending on them. The system records the RESULT of a hire, which is a staff member.
 * "Where are we short?" is now derived from unassigned sections and subjects instead of being
 * typed in by hand, so it cannot go stale.
 */
@Module({
  imports: [AccessModule, AuthModule], // AuthModule exports PasswordService (staff logins)
  controllers: [StaffController, TeacherAssignmentsController, PayrollController, PayslipsController],
  providers: [StaffService, PayrollService],
  exports: [StaffService, PayrollService],
})
export class HrModule {}
