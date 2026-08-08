import { Module } from '@nestjs/common';
import { SetupModule } from '../setup/setup.module';
import { TimetableController } from './timetable.controller';
import { TimetableService } from './timetable.service';

/** The weekly grid (§23). `SetupModule` supplies the current academic year. */
@Module({
  imports: [SetupModule],
  controllers: [TimetableController],
  providers: [TimetableService],
  exports: [TimetableService],
})
export class TimetableModule {}
