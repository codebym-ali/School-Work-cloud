import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Public, RateLimit } from '@common';
import { FeeLinkService } from './fee-link.service';
import { LinkUploadDto, SubmitLinkClaimDto } from './dto/fees.dto';

/**
 * The guardian fee link — the only **public, unauthenticated write surface** in the product.
 *
 * Everything that normally protects a route is absent here: no session, no role, no campus. The
 * signed token in the path is the whole authorisation, so the rules live in `FeeLinkService` and
 * this controller stays deliberately thin — there is nothing to get wrong in it.
 *
 * `@Public` skips auth but NOT tenancy: the school is still resolved from the Host by
 * `TenantResolutionMiddleware`, so `demo.school.pk/p/<token>` runs inside the demo tenant's RLS
 * transaction. A token minted for one school therefore cannot reach another's invoice even if
 * the id were known — the row is simply not visible.
 *
 * `@RateLimit('feeLink')` bounds it per token AND per IP: a link travels by SMS and gets
 * forwarded, so it must be assumed to leak, and a leaked link must not become a way to flood the
 * office queue or the object store.
 */
@Public()
@RateLimit('feeLink')
@Controller('public/fee-link')
export class FeeLinkController {
  constructor(private readonly feeLink: FeeLinkService) {}

  /** The child's first name, the amount, and nothing else that identifies them. */
  @Get(':token')
  view(@Param('token') token: string) {
    return this.feeLink.view(token);
  }

  @Post(':token/upload')
  upload(@Param('token') token: string, @Body() dto: LinkUploadDto) {
    return this.feeLink.requestUpload(token, dto.filename, dto.mimeType);
  }

  /** Always PENDING. Nothing a guardian does moves money — a human verifies against the bank. */
  @Post(':token/claim')
  claim(@Param('token') token: string, @Body() dto: SubmitLinkClaimDto) {
    return this.feeLink.submitClaim(token, dto);
  }
}
