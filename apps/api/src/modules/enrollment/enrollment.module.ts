import { Module } from '@nestjs/common';
import { EnrollmentController, PromotionController } from './enrollment.controller';
import { EnrollmentService } from './enrollment.service';
import { PromotionService } from './promotion.service';

@Module({
  controllers: [EnrollmentController, PromotionController],
  providers: [EnrollmentService, PromotionService],
  exports: [EnrollmentService, PromotionService],
})
export class EnrollmentModule {}
