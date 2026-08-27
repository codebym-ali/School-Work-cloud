import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '@common';
import { PlatformBillingService } from './platform-billing.service';
import { PlatformAuthGuard, PlatformRoles, CurrentPlatformUser, type PlatformActor } from './platform-auth.guard';
import { GenerateInvoiceDto, ListInvoicesQuery, RecordPaymentDto, SetPriceDto, VoidInvoiceDto } from './dto/platform.dto';

/**
 * Vendor billing (SA6, decision D3 — in-house, per-student). Every route is confined to the
 * billing-capable roles (**SUPER_ADMIN + BILLING**) — revenue figures and payment records are
 * sensitive, so even the reads carry `@PlatformRoles` rather than being open like the tenant list.
 * `@Public` skips the tenant guard chain (no tenant here); PlatformAuthGuard enforces the platform
 * session (+ CSRF on writes). Runs on the platform_admin BYPASSRLS connection.
 */
@Public()
@UseGuards(PlatformAuthGuard)
@Controller('platform/billing')
export class PlatformBillingController {
  constructor(private readonly billing: PlatformBillingService) {}

  @PlatformRoles('SUPER_ADMIN', 'BILLING')
  @Get('overview')
  overview() {
    return this.billing.getBillingOverview();
  }

  @PlatformRoles('SUPER_ADMIN', 'BILLING')
  @Get('invoices')
  invoices(@Query() q: ListInvoicesQuery) {
    return this.billing.listInvoices(q);
  }

  // Set the school's monthly per-student price (audited TENANT_PRICE_SET).
  @PlatformRoles('SUPER_ADMIN', 'BILLING')
  @Put('tenants/:id/price')
  @HttpCode(HttpStatus.OK)
  setPrice(@Param('id') id: string, @Body() dto: SetPriceDto, @CurrentPlatformUser() actor: PlatformActor, @Req() req: Request) {
    return this.billing.setPricePerStudent(id, dto.pricePerStudent, { platformUserId: actor.id, ip: req.ip });
  }

  // Generate one month's invoice for one school (audited INVOICE_GENERATED).
  @PlatformRoles('SUPER_ADMIN', 'BILLING')
  @Post('invoices')
  @HttpCode(HttpStatus.CREATED)
  generate(@Body() dto: GenerateInvoiceDto, @CurrentPlatformUser() actor: PlatformActor, @Req() req: Request) {
    return this.billing.generateInvoice(dto.tenantId, dto.year, dto.month, { platformUserId: actor.id, ip: req.ip });
  }

  // Record an OFFLINE payment against an issued invoice (audited INVOICE_PAID).
  @PlatformRoles('SUPER_ADMIN', 'BILLING')
  @Post('invoices/:id/pay')
  @HttpCode(HttpStatus.OK)
  pay(@Param('id') id: string, @Body() dto: RecordPaymentDto, @CurrentPlatformUser() actor: PlatformActor, @Req() req: Request) {
    return this.billing.recordPayment(id, dto, { platformUserId: actor.id, ip: req.ip });
  }

  // Void an issued invoice — reason required and audited (INVOICE_VOID).
  @PlatformRoles('SUPER_ADMIN', 'BILLING')
  @Post('invoices/:id/void')
  @HttpCode(HttpStatus.OK)
  void(@Param('id') id: string, @Body() dto: VoidInvoiceDto, @CurrentPlatformUser() actor: PlatformActor, @Req() req: Request) {
    return this.billing.voidInvoice(id, dto.reason, { platformUserId: actor.id, ip: req.ip });
  }
}
