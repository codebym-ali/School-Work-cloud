import { Module } from '@nestjs/common';
import { CommsModule } from '../comms/comms.module';
import { SetupService } from './setup.service';
import {
  AcademicYearController,
  CampusController,
  ClassController,
  HolidayController,
  SchoolSettingsController,
  SectionController,
  SubjectController,
} from './setup.controller';

@Module({
  // ⚠️ CommsModule, not the other way round: a closure notifies, comms does not read setup.
  imports: [CommsModule],
  controllers: [
    AcademicYearController,
    CampusController,
    ClassController,
    HolidayController,
    SchoolSettingsController,
    SectionController,
    SubjectController,
  ],
  providers: [SetupService],
  exports: [SetupService],
})
export class SetupModule {}
