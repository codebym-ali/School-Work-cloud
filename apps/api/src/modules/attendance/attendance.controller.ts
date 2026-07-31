import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '@common';
import { AttendanceService } from './attendance.service';
import {
  AttendanceCoverageQuery,
  AttendanceQuery,
  MarkAttendanceDto,
  MarkStaffAttendanceDto,
  PatchAttendanceDto,
} from './dto/attendance.dto';

@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  // Ownership (teacher assigned to section) is enforced inside the service, because
  // guards run before the withTenant tx and cannot read tenant data under RLS.
  @Roles('TEACHER', 'CAMPUS_ADMIN', 'OWNER_ADMIN')
  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  markBulk(@Body() dto: MarkAttendanceDto) {
    return this.attendance.markBulk(dto);
  }

  /** Which of the last N days this section is marked for — powers the backfill strip. */
  @Get('coverage')
  coverage(@Query() q: AttendanceCoverageQuery) {
    return this.attendance.coverage(q.sectionId, q.session, q.days ?? 7);
  }

  @Get()
  query(@Query() q: AttendanceQuery) {
    return this.attendance.query(q);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Patch(':id')
  patch(@Param('id') id: string, @Body() dto: PatchAttendanceDto) {
    return this.attendance.patch(id, dto);
  }
}

@Controller('staff-attendance')
export class StaffAttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  markBulk(@Body() dto: MarkStaffAttendanceDto) {
    return this.attendance.markStaffBulk(dto);
  }

  // Self-service: any staff member reads their own record (self-scoped in the service,
  // §22.8) — no @Roles, mirroring GET /payslips/mine.
  @Get('mine')
  mine() {
    return this.attendance.myStaffAttendance();
  }
}
