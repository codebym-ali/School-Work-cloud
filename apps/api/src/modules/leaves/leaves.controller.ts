import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Roles } from '@common';
import { LeavesService } from './leaves.service';
import {
  CreateStaffLeaveDto,
  CreateStudentLeaveDto,
  LeaveListQuery,
  RejectLeaveDto,
} from './dto/leaves.dto';

@Controller('student-leaves')
export class StudentLeavesController {
  constructor(private readonly leaves: LeavesService) {}

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER', 'PARENT')
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
