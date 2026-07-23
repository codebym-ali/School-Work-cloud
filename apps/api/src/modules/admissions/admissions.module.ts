import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { StudentsModule } from '../students/students.module';
import { AdmissionsService } from './admissions.service';
import { AdmissionsController, InquiriesController } from './admissions.controller';

@Module({
  imports: [StudentsModule, AccessModule],
  controllers: [InquiriesController, AdmissionsController],
  providers: [AdmissionsService],
  exports: [AdmissionsService],
})
export class AdmissionsModule {}
