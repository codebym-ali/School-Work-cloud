import { Controller, Get } from '@nestjs/common';
import { Public } from '@common';
import { PlatformBillingService } from './platform-billing.service';

/**
 * Public, UNAUTHENTICATED vendor endpoints (SA6d) — the marketing landing page reads the list price
 * here. `@Public()` skips the tenant guard chain and there is no PlatformAuthGuard, so this is open to
 * anyone on any host (the apex marketing site included). Only non-sensitive, advertised data belongs
 * here — never tenant data or operator info.
 */
@Public()
@Controller('platform/public')
export class PlatformPublicController {
  constructor(private readonly billing: PlatformBillingService) {}

  /** The single public per-student "list" price shown on the marketing site. */
  @Get('pricing')
  pricing() {
    return this.billing.getPublicPricing();
  }
}
