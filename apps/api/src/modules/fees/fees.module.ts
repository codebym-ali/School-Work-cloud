import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { SetupModule } from '../setup/setup.module';
import { CommsModule } from '../comms/comms.module';
import { UploadsModule } from '../uploads/uploads.module';
import { FeeSetupService } from './fee-setup.service';
import { ClaimsService } from './claims.service';
import { InvoicingService } from './invoicing.service';
import { PaymentsService } from './payments.service';
import { FeeJobsService } from './fee-jobs.service';
import { FeeLinkService } from './fee-link.service';
import { FeeLinkController } from './fee-link.controller';
import { AggregatorService } from './aggregator.service';
import { ReconciliationService } from './reconciliation.service';
import { AggregatorWebhookController } from './aggregator.controller';
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
  imports: [SetupModule, CommsModule, AccessModule, UploadsModule],
  controllers: [
    FeeHeadsController,
    FeeStructuresController,
    LateFeePolicyController,
    DiscountsController,
    FeeClaimsController,
    FeeLinkController,
    AggregatorWebhookController,
    FeesController,
  ],
  providers: [FeeSetupService, ClaimsService, InvoicingService, PaymentsService, FeeJobsService, FeeLinkService, AggregatorService, ReconciliationService],
  exports: [FeeSetupService, ClaimsService, InvoicingService, PaymentsService, FeeJobsService, FeeLinkService, AggregatorService, ReconciliationService],
})
export class FeesModule {}
