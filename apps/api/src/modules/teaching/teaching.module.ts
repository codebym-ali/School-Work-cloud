import { Module } from '@nestjs/common';
import { TeachingController } from './teaching.controller';
import { TeachingService } from './teaching.service';

/** Teacher self-service — assigned classes + section rosters (blueprint §9/§11). */
@Module({
  controllers: [TeachingController],
  providers: [TeachingService],
})
export class TeachingModule {}
