import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { SetupModule } from '../setup/setup.module';
import { CommsModule } from '../comms/comms.module';
import { FeeSetupService } from './fee-setup.service';
import { ClaimsService } from './claims.service';
import { InvoicingService } from './invoicing.service';
import { PaymentsService } from './payments.service';
import { FeeJobsService } from './fee-jobs.service';
import {
  DiscountsController,
  FeeHeadsController,
  FeeStructuresController,
  FeeClaimsController,
  FeesController,
  LateFeePolicyController,
} from './fees.controller';

/** Fees end-to-end (blueprint §12): setup, invoicing, payments, reversals, advances, jobs. */
@Module({
  imports: [SetupModule, CommsModule, AccessModule],
  controllers: [
    FeeHeadsController,
    FeeStructuresController,
    LateFeePolicyController,
    DiscountsController,
    FeeClaimsController,
    FeesController,
  ],
  providers: [FeeSetupService, ClaimsService, InvoicingService, PaymentsService, FeeJobsService],
  exports: [FeeSetupService, ClaimsService, InvoicingService, PaymentsService, FeeJobsService],
})
export class FeesModule {}
