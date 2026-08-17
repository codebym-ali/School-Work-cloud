import { Body, Controller, Delete, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { Roles } from '@common';
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
 * `ParseUUIDPipe` on every id: without it a malformed id reaches Prisma and answers **500**
 * (`Inconsistent column data: Error creating UUID`) instead of a 400, which has already cost real
 * debugging time in this repo by making a bad fixture read as a broken feature.
 */
@Controller('bell-schedules')
@Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
export class BellScheduleController {
  constructor(private readonly bell: BellScheduleService) {}

  @Get()
  list(@Query() q: BellScheduleQuery) {
    return this.bell.list(q);
  }

  @Get(':id')
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.bell.getOne(id);
  }

  @Post()
  create(@Body() dto: CreateBellScheduleDto) {
    return this.bell.create(dto);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBellScheduleDto) {
    return this.bell.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.bell.remove(id);
  }

  /**
   * Compose one day. `PUT` because it replaces the day outright — the whole point is that a day is
   * written as a unit, so there is no state in which its rows disagree with each other.
   */
  @Put(':id/days/:dayOfWeek')
  setDay(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('dayOfWeek', ParseIntPipe) dayOfWeek: number,
    @Body() dto: SetBellDayDto,
  ) {
    return this.bell.setDay(id, dayOfWeek, dto);
  }
}
