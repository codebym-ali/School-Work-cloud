import { Module } from '@nestjs/common';
import { SetupModule } from '../setup/setup.module';
import { BellScheduleController } from './bell-schedule.controller';
import { BellScheduleService } from './bell-schedule.service';

/**
 * The school's timings. `SetupModule` supplies the current academic year.
 *
 * Exported because `TimetableModule` resolves a section's schedule to decide the grid's shape — the
 * dependency runs timetable → bell-schedule and must not run back the other way.
 */
@Module({
  imports: [SetupModule],
  controllers: [BellScheduleController],
  providers: [BellScheduleService],
  exports: [BellScheduleService],
})
export class BellScheduleModule {}
