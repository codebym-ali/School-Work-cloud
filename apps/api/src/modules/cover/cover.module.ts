import { Module } from '@nestjs/common';
import { CoverController } from './cover.controller';
import { CoverService } from './cover.service';

/** Exported because `AttendanceService.assertCanMark` asks it whether a caller covers a section. */
@Module({
  controllers: [CoverController],
  providers: [CoverService],
  exports: [CoverService],
})
export class CoverModule {}
