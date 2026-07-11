import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Roles } from '@common';
import { FeeSetupService } from './fee-setup.service';
import { InvoicingService } from './invoicing.service';
import { PaymentsService } from './payments.service';
import { FeeJobsService } from './fee-jobs.service';
import {
  CreateAdvanceDto,
  CreateDiscountDto,
  CreateFeeHeadDto,
  CreateFeeStructureDto,
  CreateInvoiceBatchDto,
  DefaultersQuery,
  InvoiceListQuery,
  PayInvoiceDto,
  PaymentListQuery,
  ReasonDto,
  UpsertLateFeePolicyDto,
} from './dto/fees.dto';

@Controller('fee-heads')
export class FeeHeadsController {
  constructor(private readonly setup: FeeSetupService) {}
  @Roles('OWNER_ADMIN') @Post() create(@Body() dto: CreateFeeHeadDto) { return this.setup.createHead(dto); }
  @Get() list() { return this.setup.listHeads(); }
}

@Controller('fee-structures')
export class FeeStructuresController {
  constructor(private readonly setup: FeeSetupService) {}
  @Roles('OWNER_ADMIN') @Post() create(@Body() dto: CreateFeeStructureDto) { return this.setup.createStructure(dto); }
  @Get() list(@Query('classId') classId?: string) { return this.setup.listStructures(classId); }
}

@Controller('late-fee-policy')
export class LateFeePolicyController {
  constructor(private readonly setup: FeeSetupService) {}
  @Roles('OWNER_ADMIN') @Put() upsert(@Body() dto: UpsertLateFeePolicyDto) { return this.setup.upsertLateFeePolicy(dto); }
  @Get() get() { return this.setup.getLateFeePolicy(); }
}

@Controller('discounts')
export class DiscountsController {
  constructor(private readonly setup: FeeSetupService) {}
  @Roles('OWNER_ADMIN') @Post() create(@Body() dto: CreateDiscountDto) { return this.setup.createDiscount(dto); }
  @Get() list(@Query('studentId') studentId?: string) { return this.setup.listDiscounts(studentId); }
  @Roles('OWNER_ADMIN') @Post(':id/revoke') revoke(@Param('id') id: string) { return this.setup.revokeDiscount(id); }
}

@Controller('fees')
export class FeesController {
  constructor(
    private readonly invoicing: InvoicingService,
    private readonly payments: PaymentsService,
    private readonly jobs: FeeJobsService,
  ) {}

  @Roles('OWNER_ADMIN', 'ACCOUNTANT')
  @Post('invoice-batches')
  createBatch(@Body() dto: CreateInvoiceBatchDto) {
    return this.invoicing.createBatch(dto);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT')
  @Get('invoices')
  listInvoices(@Query() q: InvoiceListQuery) {
    return this.invoicing.list(q);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT')
  @Get('invoices/:id')
  getInvoice(@Param('id') id: string) {
    return this.invoicing.get(id);
  }

  @Roles('OWNER_ADMIN')
  @Post('invoices/:id/waive')
  waive(@Param('id') id: string, @Body() dto: ReasonDto) {
    return this.invoicing.waive(id, dto);
  }

  @Roles('OWNER_ADMIN', 'ACCOUNTANT')
  @Post('invoices/:id/payments')
  pay(@Param('id') id: string, @Body() dto: PayInvoiceDto, @Headers('idempotency-key') key: string) {
    return this.payments.pay(id, dto, key);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT')
  @Get('payments')
  listPayments(@Query() q: PaymentListQuery) {
    return this.payments.listPayments(q);
  }

  @Roles('OWNER_ADMIN')
  @Post('payments/:id/reversals')
  reverse(@Param('id') id: string, @Body() dto: ReasonDto) {
    return this.payments.reverse(id, dto);
  }

  @Roles('OWNER_ADMIN', 'ACCOUNTANT')
  @Post('advances')
  deposit(@Body() dto: CreateAdvanceDto, @Headers('idempotency-key') key: string) {
    return this.payments.deposit(dto, key);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT')
  @Get('advances')
  advances(@Query('parentId') parentId: string) {
    return this.payments.creditBalance(parentId).then((balance) => ({ parentId, balance }));
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT')
  @Get('defaulters')
  defaulters(@Query() q: DefaultersQuery) {
    return this.invoicing.defaulters(q);
  }

  // Job triggers (also run by the worker cron; see §27).
  @Roles('OWNER_ADMIN')
  @Post('jobs/mark-overdue')
  @HttpCode(HttpStatus.OK)
  markOverdue() {
    return this.jobs.markOverdue();
  }

  @Roles('OWNER_ADMIN')
  @Get('integrity-check')
  integrity() {
    return this.jobs.checkIntegrity();
  }
}
