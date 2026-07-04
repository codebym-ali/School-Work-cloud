import { Module } from '@nestjs/common';
import { StudentsModule } from '../students/students.module';
import { AdmissionsService } from './admissions.service';
import { AdmissionsController, InquiriesController } from './admissions.controller';

@Module({
  imports: [StudentsModule],
  controllers: [InquiriesController, AdmissionsController],
  providers: [AdmissionsService],
  exports: [AdmissionsService],
})
export class AdmissionsModule {}
