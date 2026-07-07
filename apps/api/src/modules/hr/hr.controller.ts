import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
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

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN') @Post() create(@Body() dto: CreateStaffDto) { return this.staff.createStaff(dto); }
  @Get() list() { return this.staff.listStaff(); }
  @Get(':id') getOne(@Param('id') id: string) { return this.staff.getStaff(id); }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post(':id/salary-structures')
  createSalary(@Param('id') id: string, @Body() dto: CreateSalaryStructureDto) { return this.staff.createSalaryStructure(id, dto); }

  @Get(':id/salary-structures')
  listSalary(@Param('id') id: string) { return this.staff.listSalaryStructures(id); }
}

@Controller('teacher-assignments')
export class TeacherAssignmentsController {
  constructor(private readonly staff: StaffService) {}

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN') @Post() create(@Body() dto: CreateTeacherAssignmentDto) { return this.staff.createAssignment(dto); }
  @Get() list(@Query('sectionId') sectionId?: string, @Query('staffId') staffId?: string) { return this.staff.listAssignments(sectionId, staffId); }
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN') @Delete(':id') remove(@Param('id') id: string) { return this.staff.deleteAssignment(id); }
}

@Controller('payroll-runs')
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @Roles('OWNER_ADMIN') @Post() run(@Body() dto: RunPayrollDto) { return this.payroll.run(dto); }
  @Roles('OWNER_ADMIN') @Get(':id') getRun(@Param('id') id: string) { return this.payroll.getRun(id); }
  @Roles('OWNER_ADMIN') @Post(':id/approve') approve(@Param('id') id: string) { return this.payroll.approve(id); }
}

@Controller('payslips')
export class PayslipsController {
  constructor(private readonly payroll: PayrollService) {}

  @Get('mine') mine() { return this.payroll.myPayslips(); }

  // Owner-or-admin check is in the service (§22.8), so no @Roles here.
  @Get(':id/pdf') pdf(@Param('id') id: string) { return this.payroll.payslipPdf(id); }

  @Roles('OWNER_ADMIN')
  @Patch(':id/mark-paid')
  markPaid(@Param('id') id: string, @Body() dto: MarkPaidDto) { return this.payroll.markPaid(id, dto); }
}
