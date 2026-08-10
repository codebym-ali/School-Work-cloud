import { Module } from '@nestjs/common';
import { CoverModule } from '../cover/cover.module';
import { SetupModule } from '../setup/setup.module';
import { CommsModule } from '../comms/comms.module';
import { AttendanceController, StaffAttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';

@Module({
  imports: [CoverModule, SetupModule, CommsModule],
  controllers: [AttendanceController, StaffAttendanceController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
