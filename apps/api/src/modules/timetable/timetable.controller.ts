import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { OwnerWritable, Roles } from '@common';
import { TimetableService } from './timetable.service';
import { CopyDayDto, SetSlotDto, TimetableQuery } from './dto/timetable.dto';

/**
 * Timetable (blueprint §23 row "Teacher assignments & timetable").
 *
 * Writes are OWNER_ADMIN and CAMPUS_ADMIN; the campus half is narrowed **in the service**, not
 * here, because §22.8 guards run before the tenant transaction and would read zero rows.
 */
@OwnerWritable()
@Controller('timetable')
export class TimetableController {
  constructor(private readonly timetable: TimetableService) {}

  /**
   * The caller's own week — a teacher's periods or a student's.
   *
   * Declared before `section/:id` and carrying no `@Roles` on purpose: this is ownership-scoped
   * like `/payslips/mine`, it takes no id, and an account that is neither staff nor an enrolled
   * student gets an empty week rather than a 403.
   */
  @Get('mine')
  mine(@Query() q: TimetableQuery) {
    return this.timetable.mine(q);
  }

  /** Which sections have no timetable yet — "not built" is a different problem from "empty". */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Get('coverage')
  coverage(@Query() q: TimetableQuery) {
    return this.timetable.coverage(q);
  }

  /** One section's grid. TEACHER may read it — they need the class's shape, not just their own
   *  periods — and the service still enforces campus scope for a campus admin. */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER')
  @Get('section/:sectionId')
  forSection(@Param('sectionId') sectionId: string, @Query() q: TimetableQuery) {
    return this.timetable.forSection(sectionId, q);
  }

  /** Fill or replace one cell. Idempotent per (section, year, day, period). */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post('slots')
  setSlot(@Body() dto: SetSlotDto) {
    return this.timetable.setSlot(dto);
  }

  /**
   * Copy one day's lessons onto others. Returns `{ created, skipped }` — a partial copy is the
   * normal outcome once a week is half built, so it is reported rather than treated as failure.
   */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post('copy-day')
  copyDay(@Body() dto: CopyDayDto) {
    return this.timetable.copyDay(dto);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Delete('slots/:id')
  clearSlot(@Param('id') id: string) {
    return this.timetable.clearSlot(id);
  }
}
