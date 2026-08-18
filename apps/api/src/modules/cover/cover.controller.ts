import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { Roles } from '@common';
import { CoverService } from './cover.service';
import { CoverQuery, CoverSuggestionQuery, CreateCoverDto, CreateCoverRangeDto } from './dto/cover.dto';

/**
 * Cover (Cover Plan, C0–C1).
 *
 * **Arranging cover is a permission grant**, so it sits with the people who approve leave:
 * OWNER_ADMIN and CAMPUS_ADMIN. The campus half is narrowed in the service, not here — §22.8
 * guards run before the tenant transaction and would read zero rows.
 *
 * ⚠️ **`@Roles` is per method, not on the class.** `/cover/mine` (C2) is self-scoped and must be
 * open to the teacher it is about, and `RolesGuard` reads with `getAllAndOverride([handler,
 * class])` — a handler with no metadata of its own inherits the class's, so a class-level
 * decorator cannot be opted out of. The cost is that a new admin route with no `@Roles` would be
 * open to every signed-in user; the permission matrix has a row per route here, which is what
 * turns that from a silent hole into a failing test.
 */
@Controller('cover')
export class CoverController {
  constructor(private readonly cover: CoverService) {}

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Get()
  list(@Query() q: CoverQuery) {
    return this.cover.list(q);
  }

  /** Who is away and which of their classes still needs somebody — the morning worklist. */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Get('away')
  away(@Query() q: CoverQuery) {
    return this.cover.away(q);
  }

  /**
   * Who could take this class, best first, each with the reason (C3). Admin-only: it reads the
   * whole staff body's attendance and timetable, which is oversight, not self-service.
   */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Get('suggestions')
  suggestions(@Query() q: CoverSuggestionQuery) {
    return this.cover.suggestions(q);
  }

  /**
   * What I am covering, and what of mine is covered (C2).
   *
   * **No `@Roles` — self-scoped, like `/staff-attendance/mine` and `/payslips/mine`.** The gate is
   * ownership, not role: the service resolves the caller's own staff profile and can return
   * nothing else. A teacher must be able to see the class they have been handed, and telling the
   * absent teacher who took their class is the other half of not being covered in silence.
   */
  @Get('mine')
  mine(@Query() q: CoverQuery) {
    return this.cover.mine(q);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post()
  create(@Body() dto: CreateCoverDto) {
    return this.cover.create(dto);
  }

  /**
   * A known multi-day absence. **200, not 201**: some days in a range are legitimately skipped
   * (closed, or already covered), so the answer is a summary of what happened rather than a
   * created row — the same partial-outcome shape as `POST /attendance/bulk` (§25.3).
   */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post('range')
  @HttpCode(HttpStatus.OK)
  createRange(@Body() dto: CreateCoverRangeDto) {
    return this.cover.createRange(dto);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.cover.remove(id);
  }
}
