import { Module } from '@nestjs/common';
import { SetupModule } from '../setup/setup.module';
import { CoverController } from './cover.controller';
import { CoverService } from './cover.service';

/** Exported because `AttendanceService.assertCanMark` asks it whether a caller covers a section. */
@Module({
  imports: [SetupModule],
  controllers: [CoverController],
  providers: [CoverService],
  exports: [CoverService],
})
export class CoverModule {}
