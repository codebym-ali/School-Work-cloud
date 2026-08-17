import { Module } from '@nestjs/common';
import { BellScheduleModule } from '../bell-schedule/bell-schedule.module';
import { SetupModule } from '../setup/setup.module';
import { TimetableController } from './timetable.controller';
import { TimetableService } from './timetable.service';

/**
 * The weekly grid (§23). `SetupModule` supplies the current academic year; `BellScheduleModule`
 * supplies the day's shape, which is what the grid renders instead of guessing at `max(periodNo)`.
 * The dependency runs timetable → bell-schedule and must never run back.
 */
@Module({
  imports: [SetupModule, BellScheduleModule],
  controllers: [TimetableController],
  providers: [TimetableService],
  exports: [TimetableService],
})
export class TimetableModule {}
