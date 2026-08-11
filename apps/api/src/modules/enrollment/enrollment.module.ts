import { Module } from '@nestjs/common';
import { SetupModule } from '../setup/setup.module';
import { EnrollmentController, PromotionController } from './enrollment.controller';
import { EnrollmentService } from './enrollment.service';
import { PromotionService } from './promotion.service';

@Module({
  // For the shared section-capacity rule, which admission and transfer must not implement twice.
  imports: [SetupModule],
  controllers: [EnrollmentController, PromotionController],
  providers: [EnrollmentService, PromotionService],
  exports: [EnrollmentService, PromotionService],
})
export class EnrollmentModule {}
