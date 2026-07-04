import { Module } from '@nestjs/common';
import { SetupService } from './setup.service';
import {
  AcademicYearController,
  CampusController,
  ClassController,
  SectionController,
  SubjectController,
} from './setup.controller';

@Module({
  controllers: [
    AcademicYearController,
    CampusController,
    ClassController,
    SectionController,
    SubjectController,
  ],
  providers: [SetupService],
  exports: [SetupService],
})
export class SetupModule {}
