import { Module } from '@nestjs/common';
import { SetupModule } from '../setup/setup.module';
import { CommsModule } from '../comms/comms.module';
import { FeeSetupService } from './fee-setup.service';
import { InvoicingService } from './invoicing.service';
import { PaymentsService } from './payments.service';
import { FeeJobsService } from './fee-jobs.service';
import {
  DiscountsController,
  FeeHeadsController,
  FeeStructuresController,
  FeesController,
  LateFeePolicyController,
} from './fees.controller';

/** Fees end-to-end (blueprint §12): setup, invoicing, payments, reversals, advances, jobs. */
@Module({
  imports: [SetupModule, CommsModule],
  controllers: [
    FeeHeadsController,
    FeeStructuresController,
    LateFeePolicyController,
    DiscountsController,
    FeesController,
  ],
  providers: [FeeSetupService, InvoicingService, PaymentsService, FeeJobsService],
  exports: [FeeSetupService, InvoicingService, PaymentsService, FeeJobsService],
})
export class FeesModule {}
