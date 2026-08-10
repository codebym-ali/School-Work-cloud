import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { Roles } from '@common';
import { CoverService } from './cover.service';
import { CoverQuery, CreateCoverDto, CreateCoverRangeDto } from './dto/cover.dto';

/**
 * Cover (Cover Plan, C0).
 *
 * **Arranging cover is a permission grant**, so it sits with the people who approve leave:
 * OWNER_ADMIN and CAMPUS_ADMIN. The campus half is narrowed in the service, not here — §22.8
 * guards run before the tenant transaction and would read zero rows.
 *
 * A teacher does not need a route of their own: cover simply makes `POST /attendance/bulk` start
 * working for that section, and their existing screens show it.
 */
@Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
@Controller('cover')
export class CoverController {
  constructor(private readonly cover: CoverService) {}

  @Get()
  list(@Query() q: CoverQuery) {
    return this.cover.list(q);
  }

  /** Who is away and which of their classes still needs somebody — the morning worklist. */
  @Get('away')
  away(@Query() q: CoverQuery) {
    return this.cover.away(q);
  }

  @Post()
  create(@Body() dto: CreateCoverDto) {
    return this.cover.create(dto);
  }

  /**
   * A known multi-day absence. **200, not 201**: some days in a range are legitimately skipped
   * (closed, or already covered), so the answer is a summary of what happened rather than a
   * created row — the same partial-outcome shape as `POST /attendance/bulk` (§25.3).
   */
  @Post('range')
  @HttpCode(HttpStatus.OK)
  createRange(@Body() dto: CreateCoverRangeDto) {
    return this.cover.createRange(dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.cover.remove(id);
  }
}
