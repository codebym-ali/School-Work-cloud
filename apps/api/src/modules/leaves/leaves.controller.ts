import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { OwnerWritable, Roles } from '@common';
import { LeavesService } from './leaves.service';
import {
  CreateStaffLeaveDto,
  CreateStudentLeaveDto,
  LeaveBalanceQuery,
  LeaveListQuery,
  RejectLeaveDto,
} from './dto/leaves.dto';

@OwnerWritable()
@Controller('student-leaves')
export class StudentLeavesController {
  constructor(private readonly leaves: LeavesService) {}

  // PARENT dropped 2026-07-28 — the parent portal was its only client (see Key Decisions).
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER')
  @Post()
  create(@Body() dto: CreateStudentLeaveDto) {
    return this.leaves.createStudentLeave(dto);
  }

  @Get()
  list(@Query() q: LeaveListQuery) {
    return this.leaves.listStudentLeaves(q);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post(':id/approve')
  approve(@Param('id') id: string) {
    return this.leaves.approveStudentLeave(id);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post(':id/reject')
  reject(@Param('id') id: string, @Body() dto: RejectLeaveDto) {
    return this.leaves.rejectStudentLeave(id, dto);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.leaves.cancelStudentLeave(id);
  }
}

@OwnerWritable()
@Controller('staff-leaves')
export class StaffLeavesController {
  constructor(private readonly leaves: LeavesService) {}

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER', 'STAFF')
  @Post()
  create(@Body() dto: CreateStaffLeaveDto) {
    return this.leaves.createStaffLeave(dto);
  }

  @Get()
  list(@Query() q: LeaveListQuery) {
    return this.leaves.listStaffLeaves(q);
  }

  /**
   * No `@Roles` — self-service, like `/staff-attendance/mine` and `/payslips/mine`. The service
   * forces a non-admin to their own profile, so the gate is ownership, not role: anyone with a
   * staff profile may read their own entitlement, and nobody may read someone else's.
   *
   * Declared BEFORE `:id/...` routes would be an issue if any GET took an id — none does, but
   * keep it above them if that changes, or `balance` starts looking like a uuid.
   */
  @Get('balance')
  balance(@Query() q: LeaveBalanceQuery) {
    return this.leaves.staffLeaveBalance(q);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post(':id/approve')
  approve(@Param('id') id: string) {
    return this.leaves.approveStaffLeave(id);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post(':id/reject')
  reject(@Param('id') id: string, @Body() dto: RejectLeaveDto) {
    return this.leaves.rejectStaffLeave(id, dto);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.leaves.cancelStaffLeave(id);
  }
}
