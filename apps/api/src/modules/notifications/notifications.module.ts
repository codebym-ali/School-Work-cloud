import { Module } from '@nestjs/common';
import { AdmissionsModule } from '../admissions/admissions.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { CoverModule } from '../cover/cover.module';
import { FeesModule } from '../fees/fees.module';
import { ReportsModule } from '../reports/reports.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  // Composed rather than reimplemented — these own the derivations. Nothing imports
  // NotificationsModule, so there is no cycle to worry about here.
  imports: [ReportsModule, AttendanceModule, CoverModule, FeesModule, AdmissionsModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
