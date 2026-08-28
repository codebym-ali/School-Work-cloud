import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Public } from '@common';
import { PlatformBillingService } from './platform-billing.service';
import { PlatformLeadsService } from './platform-leads.service';
import { DemoRequestDto } from './dto/platform.dto';

/**
 * Public, UNAUTHENTICATED vendor endpoints (SA6d / SA8) — the marketing landing page reads the list
 * price here and submits demo requests here. `@Public()` skips the tenant guard chain and there is no
 * PlatformAuthGuard, so these are open to anyone on any host (the apex marketing site included). Only
 * non-sensitive advertised data (the price) is READ here; the WRITE (a lead) is inbound-only.
 */
@Public()
@Controller('platform/public')
export class PlatformPublicController {
  constructor(
    private readonly billing: PlatformBillingService,
    private readonly leads: PlatformLeadsService,
  ) {}

  /** The single public per-student "list" price shown on the marketing site. */
  @Get('pricing')
  pricing() {
    return this.billing.getPublicPricing();
  }

  /**
   * Capture a demo/contact request from the marketing site (SA8). Public — no session, no CSRF token
   * (the CsrfGuard skips @Public + sessionless requests). The `website` field is a honeypot: a real
   * visitor never sees it, so if it's filled we accept the request (200) but save nothing.
   */
  @Post('demo-request')
  @HttpCode(HttpStatus.CREATED)
  demoRequest(@Body() dto: DemoRequestDto) {
    if (dto.website) return { ok: true };
    return this.leads.createLead({
      name: dto.name,
      email: dto.email,
      schoolName: dto.schoolName,
      phone: dto.phone,
      studentCount: dto.studentCount,
      message: dto.message,
    });
  }
}
