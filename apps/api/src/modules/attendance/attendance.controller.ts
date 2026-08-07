import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '@common';
import { AttendanceService } from './attendance.service';
import {
  AttendanceCoverageQuery,
  AttendanceQuery,
  MarkAttendanceDto,
  MarkStaffAttendanceDto,
  MyStaffAttendanceQuery,
  PatchAttendanceDto,
  StaffHistoryQuery,
  StaffRegisterQuery,
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

  /**
   * Is the school shut today or tomorrow? Drives the banner in the app shell (H2).
   *
   * **No `@Roles`** — deliberately every authenticated user. A closure notice that only admins
   * could see would miss teachers entirely (they have no dashboard), and students and staff need
   * it just as much. It reveals nothing but a date and the school's own closure name.
   */
  @Get('closure-notice')
  closureNotice() {
    return this.attendance.closureNotice();
  }

  /**
   * Which registers are still unmarked today (G3) — the head's view, so admins only.
   *
   * Deliberately NOT open to TEACHER: this is a list of colleagues who are behind, and a teacher
   * needs their own coverage strip, not a leaderboard of everyone else's.
   */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Get('unmarked-today')
  unmarkedToday() {
    return this.attendance.unmarkedToday();
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
  mine(@Query() q: MyStaffAttendanceQuery) {
    return this.attendance.myStaffAttendance(q.from, q.to);
  }

  @Get('mine/summary')
  mineSummary(@Query() q: MyStaffAttendanceQuery) {
    return this.attendance.myStaffAttendanceSummary(q.from, q.to);
  }

  /** Whether the button should be shown, and what it would record. */
  @Get('mine/check-in')
  checkInState() {
    return this.attendance.myCheckInState();
  }

  /**
   * Mark yourself present for today. Deliberately takes NO body: the date is today, the person
   * is the caller, and the status comes from the clock — so there is nothing to tamper with.
   */
  @Post('check-in')
  @HttpCode(HttpStatus.CREATED)
  checkIn() {
    return this.attendance.checkIn();
  }

  // ── Oversight. HR_MANAGER reads but never marks: they own the workforce record, and
  // attendance feeds pay — the same boundary that keeps salary structures owner-only.
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'HR_MANAGER')
  @Get('summary')
  summary(@Query() q: StaffRegisterQuery) {
    return this.attendance.staffDaySummary(q.date, q.campusId);
  }

  /** The day's register — every staff member, including those nobody has marked. */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'HR_MANAGER')
  @Get()
  register(@Query() q: StaffRegisterQuery) {
    return this.attendance.staffRegister(q.date, q.status, q.campusId);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'HR_MANAGER')
  @Get('staff/:staffId')
  history(@Param('staffId') staffId: string, @Query() q: StaffHistoryQuery) {
    return this.attendance.staffHistory(staffId, q.from, q.to);
  }
}
