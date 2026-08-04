import { Body, Controller, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Public, RateLimit } from '@common';
import { AggregatorService } from './aggregator.service';
import { AggregatorSettlementDto } from './dto/fees.dto';

/**
 * Aggregator settlement callbacks (Fee Submission Plan §5.3) — the seam, not an integration.
 *
 * Public and unauthenticated like the SMS delivery webhook: the caller is a bank, so there is no
 * session and no Host to resolve a tenant from. **The HMAC signature is the entire auth**, and
 * the PSID carries the tenancy.
 *
 * Rate-limited even though it is inert: an endpoint that verifies signatures is an endpoint
 * someone can grind against, and remembering to add the limiter on the day it goes live is
 * exactly the kind of thing that gets forgotten under deadline.
 */
@Public()
@RateLimit('feeLink')
@Controller('webhooks/fee-settlement')
export class AggregatorWebhookController {
  constructor(private readonly aggregator: AggregatorService) {}

  @Post(':provider')
  @HttpCode(HttpStatus.NO_CONTENT)
  async settle(
    @Headers('x-signature') signature: string | undefined,
    @Body() dto: AggregatorSettlementDto,
  ): Promise<void> {
    await this.aggregator.settle(signature, dto);
  }
}
