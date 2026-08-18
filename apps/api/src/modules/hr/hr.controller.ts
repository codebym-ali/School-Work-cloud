import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '@common';
import { StaffService } from './staff.service';
import { PayrollService } from './payroll.service';
import {
  CreateSalaryStructureDto,
  CreateStaffDto,
  CreateTeacherAssignmentDto,
  MarkPaidDto,
  RunPayrollDto,
} from './dto/hr.dto';

@Controller('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  // HR_MANAGER included: adding a teacher IS this role's job now that recruitment is gone.
  // Salary and payroll deliberately stay owner-only — whoever creates an employee must not
  // also set their pay, or one person can invent a staff member on a salary unobserved.
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'HR_MANAGER') @Post() create(@Body() dto: CreateStaffDto) { return this.staff.createStaff(dto); }
  @Get() list() { return this.staff.listStaff(); }

  /** HR rollup: headcount, joiners, half-finished setups and uncovered subjects. */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'HR_MANAGER')
  @Get('summary')
  summary() { return this.staff.hrSummary(); }
  @Get(':id') getOne(@Param('id', ParseUUIDPipe) id: string) { return this.staff.getStaff(id); }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post(':id/salary-structures')
  createSalary(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateSalaryStructureDto) { return this.staff.createSalaryStructure(id, dto); }

  @Get(':id/salary-structures')
  listSalary(@Param('id', ParseUUIDPipe) id: string) { return this.staff.listSalaryStructures(id); }
}

@Controller('teacher-assignments')
export class TeacherAssignmentsController {
  constructor(private readonly staff: StaffService) {}

  // HR_MANAGER may assign teaching duty, gated by the `hr.assign` module so the owner can
  // withhold it — in a larger school this is the principal's call, in a small one it is HR's.
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'HR_MANAGER') @Post() create(@Body() dto: CreateTeacherAssignmentDto) { return this.staff.createAssignment(dto); }
  // `academicYearId` is optional and defaults to the current year — a teaching record is per
  // year, and returning all of them let the class screen mistake last year's teacher for this
  // year's and delete the historical row when reassigning.
  @Get() list(
    @Query('sectionId') sectionId?: string,
    @Query('staffId') staffId?: string,
    @Query('academicYearId') academicYearId?: string,
  ) { return this.staff.listAssignments(sectionId, staffId, academicYearId); }
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'HR_MANAGER') @Delete(':id') remove(@Param('id', ParseUUIDPipe) id: string) { return this.staff.deleteAssignment(id); }
}

@Controller('payroll-runs')
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @Roles('OWNER_ADMIN') @Post() run(@Body() dto: RunPayrollDto) { return this.payroll.run(dto); }
  @Roles('OWNER_ADMIN') @Get(':id') getRun(@Param('id', ParseUUIDPipe) id: string) { return this.payroll.getRun(id); }
  @Roles('OWNER_ADMIN') @Post(':id/approve') approve(@Param('id', ParseUUIDPipe) id: string) { return this.payroll.approve(id); }
}

@Controller('payslips')
export class PayslipsController {
  constructor(private readonly payroll: PayrollService) {}

  @Get('mine') mine() { return this.payroll.myPayslips(); }

  // Owner-or-admin check is in the service (§22.8), so no @Roles here.
  @Get(':id/pdf') pdf(@Param('id', ParseUUIDPipe) id: string) { return this.payroll.payslipPdf(id); }

  @Roles('OWNER_ADMIN')
  @Patch(':id/mark-paid')
  markPaid(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MarkPaidDto) { return this.payroll.markPaid(id, dto); }
}
