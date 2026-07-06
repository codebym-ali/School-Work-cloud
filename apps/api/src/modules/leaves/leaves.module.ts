import { Module } from '@nestjs/common';
import { CommsModule } from '../comms/comms.module';
import { StaffLeavesController, StudentLeavesController } from './leaves.controller';
import { LeavesService } from './leaves.service';

@Module({
  imports: [CommsModule],
  controllers: [StudentLeavesController, StaffLeavesController],
  providers: [LeavesService],
  exports: [LeavesService],
})
export class LeavesModule {}
