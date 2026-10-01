import { Module } from '@nestjs/common';
import { FeesModule } from '../fees/fees.module';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';

/** What the owner must sign off before it takes effect: a campus's monthly fee vouchers (and, later, setup changes). */
@Module({
  imports: [FeesModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
