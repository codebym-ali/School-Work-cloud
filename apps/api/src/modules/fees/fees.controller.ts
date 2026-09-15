import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Roles } from '@common';
import { ClaimSource } from '@prisma/client';
import { ClaimsService } from './claims.service';
import { FeeSetupService } from './fee-setup.service';
import { InvoicingService } from './invoicing.service';
import { PaymentsService } from './payments.service';
import { FeeJobsService } from './fee-jobs.service';
import { FeeLinkService } from './fee-link.service';
import { ReconciliationService } from './reconciliation.service';
import {
  CopyFeePlanDto,
  CreateAdvanceDto,
  CreateDiscountDto,
  CreateFeeHeadDto,
  CreateFeeStructureDto,
  UpdateFeeStructureDto,
  ClaimListQuery,
  CreateInvoiceBatchDto,
  CreateStudentInvoiceDto,
  RejectClaimDto,
  SubmitClaimDto,
  DefaultersQuery,
  InvoiceListQuery,
  PayInvoiceDto,
  PaymentListQuery,
  ReasonDto,
  UpsertLateFeePolicyDto,
  ImportStatementDto,
} from './dto/fees.dto';

@Controller('fee-heads')
export class FeeHeadsController {
  constructor(private readonly setup: FeeSetupService) {}
  @Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN') @Post() create(@Body() dto: CreateFeeHeadDto) { return this.setup.createHead(dto); }
  // Reads were left unguarded here while every write was owner-only, so the whole fee catalogue
  // was readable by any authenticated session — teacher, student, parent. An endpoint's read is
  // not "the safe half"; it is the half that leaks. `/fees` is the only caller (owner+cashier).
  @Roles('OWNER_ADMIN', 'ACCOUNTANT') @Get() list() { return this.setup.listHeads(); }
  // Renaming and removing were missing entirely, so the list only ever grew — a school could
  // not clear a typo, let alone anything a test run left behind.
  @Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN') @Patch(':id') update(@Param('id') id: string, @Body() dto: CreateFeeHeadDto) {
    return this.setup.updateHead(id, dto);
  }
  @Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN') @Delete(':id') @HttpCode(HttpStatus.NO_CONTENT) remove(@Param('id') id: string) {
    return this.setup.deleteHead(id);
  }
}

@Controller('fee-structures')
export class FeeStructuresController {
  constructor(private readonly setup: FeeSetupService) {}
  @Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN') @Post() create(@Body() dto: CreateFeeStructureDto) { return this.setup.createStructure(dto); }
  // CAMPUS_ADMIN included: the class workbench (`/classes/[id]`) shows the class's fee plan, and
  // that screen is theirs. They may read the plan for their campus's classes, never change it.
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT')
  @Get() list(@Query('classId') classId?: string) { return this.setup.listStructures(classId); }

  /** Copy a plan across classes, or roll a year forward with an optional rise. */
  @Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN') @Post('copy') copy(@Body() dto: CopyFeePlanDto) { return this.setup.copyPlan(dto); }

  // Amount is editable only until something has been billed from it; after that the honest
  // change is a revision from a later month. Switching a fee off is always allowed.
  @Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN') @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateFeeStructureDto) {
    return this.setup.updateStructure(id, dto);
  }

  @Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN') @Delete(':id') @HttpCode(HttpStatus.NO_CONTENT) remove(@Param('id') id: string) {
    return this.setup.deleteStructure(id);
  }
}

@Controller('late-fee-policy')
export class LateFeePolicyController {
  constructor(private readonly setup: FeeSetupService) {}
  @Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN') @Put() upsert(@Body() dto: UpsertLateFeePolicyDto) { return this.setup.upsertLateFeePolicy(dto); }
  @Roles('OWNER_ADMIN', 'ACCOUNTANT') @Get() get() { return this.setup.getLateFeePolicy(); }
}

@Controller('discounts')
export class DiscountsController {
  constructor(private readonly setup: FeeSetupService) {}
  @Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN') @Post() create(@Body() dto: CreateDiscountDto) { return this.setup.createDiscount(dto); }
  // The worst of the four that shipped unguarded: `?studentId=` returns a named child's fee
  // concessions — hardship, staff-child, sibling — which any authenticated user could read,
  // including that child's classmates. Narrowest set that matches the writes; no UI calls it yet.
  @Roles('OWNER_ADMIN', 'ACCOUNTANT')
  @Get() list(@Query('studentId') studentId?: string) { return this.setup.listDiscounts(studentId); }
  @Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN') @Post(':id/revoke') revoke(@Param('id') id: string) { return this.setup.revokeDiscount(id); }
}

/**
 * Payment submissions — "somebody says they have paid".
 *
 * Separate from `/fees` on purpose: these are CLAIMS, and nothing here moves money until a
 * human verifies one. The office may record and verify in a single call because the clerk who
 * took the money is the verifier; anything self-submitted waits.
 */
@Controller('fees/claims')
export class FeeClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  @Roles('OWNER_ADMIN', 'ACCOUNTANT')
  @Post()
  submit(@Body() dto: SubmitClaimDto) {
    return this.claims.submit(dto, ClaimSource.OFFICE, dto.autoVerify ?? false);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT')
  @Get()
  list(@Query() q: ClaimListQuery) {
    return this.claims.list(q);
  }

  /** Powers the dashboard chip — claims arrive and nobody looks without one. */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT')
  @Get('pending-count')
  pendingCount() {
    return this.claims.pendingCount().then((pending) => ({ pending }));
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT')
  @Get(':id/proof')
  proof(@Param('id') id: string) {
    return this.claims.proofUrl(id);
  }

  // Confirming money arrived is what creates the receipt, so it is the cashier's call, not a
  // campus admin's — the same audience that may take a payment in the first place.
  @Roles('OWNER_ADMIN', 'ACCOUNTANT')
  @Post(':id/verify')
  verify(@Param('id') id: string) {
    return this.claims.verify(id);
  }

  @Roles('OWNER_ADMIN', 'ACCOUNTANT')
  @Post(':id/reject')
  reject(@Param('id') id: string, @Body() dto: RejectClaimDto) {
    return this.claims.reject(id, dto);
  }
}

@Controller('fees')
export class FeesController {
  constructor(
    private readonly invoicing: InvoicingService,
    private readonly payments: PaymentsService,
    private readonly jobs: FeeJobsService,
    private readonly feeLink: FeeLinkService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  @Roles('OWNER_ADMIN', 'ACCOUNTANT')
  @Post('invoice-batches')
  createBatch(@Body() dto: CreateInvoiceBatchDto) {
    return this.invoicing.createBatch(dto);
  }

  /**
   * Invoice ONE student (Fees Billing Plan, B1) — the cashier's "open the child, press generate"
   * path, and the only way to bill a student admitted after their class's batch already ran.
   *
   * ⚠️ **Exactly the roles the batch has — OWNER_ADMIN and ACCOUNTANT.** The first draft added
   * CAMPUS_ADMIN, which would have made the new path WIDER than the one it parallels; a campus
   * admin can read fees but has never been able to create them. The service adds `fees.invoicing` and the
   * campus check off the student's own enrolment, because a caller must not be trusted to say which
   * class prices a child.
   */
  @Roles('OWNER_ADMIN', 'ACCOUNTANT')
  @Post('invoices')
  createInvoice(@Body() dto: CreateStudentInvoiceDto, @Headers('idempotency-key') key: string) {
    return this.invoicing.createForStudent(dto, key);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT')
  @Get('invoices')
  listInvoices(@Query() q: InvoiceListQuery) {
    return this.invoicing.list(q);
  }

  /**
   * Mint a guardian upload link for one invoice (§5.2).
   *
   * Owner/cashier only, and a POST rather than a GET: it creates a bearer credential that lets
   * whoever holds it file a claim against this invoice, so it should not be sitting in a browser
   * history or a proxy log because someone opened a page.
   */
  @Roles('OWNER_ADMIN', 'ACCOUNTANT')
  @Post('invoices/:id/guardian-link')
  guardianLink(@Param('id') id: string, @Headers('host') host?: string) {
    return this.feeLink.issueFor(id, host);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT')
  @Get('invoices/:id')
  getInvoice(@Param('id') id: string) {
    return this.invoicing.get(id);
  }

  // Ops Admin included (Operations Admin Role Plan, decision D-B: waivers allowed + audited). The
  // deputy runs finance on the owner's behalf; the write is recorded under their own id.
  @Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN')
  @Post('invoices/:id/waive')
  waive(@Param('id') id: string, @Body() dto: ReasonDto) {
    return this.invoicing.waive(id, dto);
  }

  @Roles('OWNER_ADMIN', 'ACCOUNTANT')
  @Post('invoices/:id/payments')
  pay(@Param('id') id: string, @Body() dto: PayInvoiceDto, @Headers('idempotency-key') key: string) {
    return this.payments.pay(id, dto, key);
  }

  /** A short-lived link to the proof attached to one payment. Keyed on the PAYMENT, never on
   *  the file key — resolving the key only after authorising the payment is what stops an
   *  opaque string being replayed for someone else's document. */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT')
  @Get('payments/:id/proof')
  proof(@Param('id') id: string) {
    return this.payments.proofUrl(id);
  }

  /** The receipt itself, as a PDF — what the family asks for at the counter. */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT')
  @Get('payments/:id/receipt')
  receipt(@Param('id') id: string) {
    return this.payments.receiptPdf(id);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT')
  @Get('payments')
  listPayments(@Query() q: PaymentListQuery) {
    return this.payments.listPayments(q);
  }

  // Ops Admin included (Operations Admin Role Plan, decision D-B: reversals allowed + audited).
  @Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN')
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

  // Job triggers (also run by the worker cron; see §27). Ops Admin may run the defaulters sweep
  // (operational); integrity-check below stays owner-only (a diagnostic, not a daily-ops task).
  @Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN')
  @Post('jobs/mark-overdue')
  @HttpCode(HttpStatus.OK)
  markOverdue() {
    return this.jobs.markOverdue();
  }

  /**
   * Bank statement reconciliation (Fees Gaps Register).
   *
   * ⚠️ Accountant and owner only — the same two roles that may collect money. A campus admin can
   * read claims but must not see another campus's bank statement, and the service scopes matching
   * to their campus in any case.
   *
   * ⚠️ None of these verify anything. `preview` writes nothing at all; `import` stores lines and
   * records which claim each corroborates. Turning a match into a receipt remains a human click on
   * the ordinary verify path.
   */
  @Roles('OWNER_ADMIN', 'ACCOUNTANT')
  @Post('statements/preview')
  @HttpCode(HttpStatus.OK)
  previewStatement(@Body() dto: ImportStatementDto) {
    return this.reconciliation.preview(dto);
  }

  @Roles('OWNER_ADMIN', 'ACCOUNTANT')
  @Post('statements')
  importStatement(@Body() dto: ImportStatementDto) {
    return this.reconciliation.commit(dto);
  }

  /** Money in the bank that no claim explains — see the service for why this matters most. */
  @Roles('OWNER_ADMIN', 'ACCOUNTANT')
  @Get('statements/unexplained')
  unexplained(@Query('days') days?: string) {
    return this.reconciliation.unexplained(days ? Number(days) : undefined);
  }

  @Roles('OWNER_ADMIN')
  @Get('integrity-check')
  integrity() {
    return this.jobs.checkIntegrity();
  }
}
