import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { OwnerWritable, Roles } from '@common';
import { BellScheduleService } from './bell-schedule.service';
import {
  BellScheduleQuery,
  CreateBellScheduleDto,
  SetBellDayDto,
  UpdateBellScheduleDto,
} from './dto/bell-schedule.dto';

/**
 * The school's timings (bell schedule).
 *
 * Writes are OWNER_ADMIN and CAMPUS_ADMIN; the campus half is narrowed **in the service**, not here,
 * because §22.8 guards run before the tenant transaction and would read zero rows under RLS.
 *
 * Ids need no per-route pipe: `UuidParamPipe` is bound globally as `APP_PIPE`, so `id` and any
 * `<entity>Id` is format-checked at the edge for every route in the repo — including ones added
 * later, which is the half a per-route pipe cannot cover.
 */
@OwnerWritable()
@Controller('bell-schedules')
@Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
export class BellScheduleController {
  constructor(private readonly bell: BellScheduleService) {}

  @Get()
  list(@Query() q: BellScheduleQuery) {
    return this.bell.list(q);
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.bell.getOne(id);
  }

  @Post()
  create(@Body() dto: CreateBellScheduleDto) {
    return this.bell.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateBellScheduleDto) {
    return this.bell.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.bell.remove(id);
  }

  /**
   * Compose one day. `PUT` because it replaces the day outright — the whole point is that a day is
   * written as a unit, so there is no state in which its rows disagree with each other.
   */
  @Put(':id/days/:dayOfWeek')
  setDay(
    @Param('id') id: string,
    @Param('dayOfWeek', ParseIntPipe) dayOfWeek: number,
    @Body() dto: SetBellDayDto,
  ) {
    return this.bell.setDay(id, dayOfWeek, dto);
  }
}
