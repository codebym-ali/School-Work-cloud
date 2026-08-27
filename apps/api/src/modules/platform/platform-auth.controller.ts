import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public, RateLimit } from '@common';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformAuthGuard, CurrentPlatformUser, type PlatformActor } from './platform-auth.guard';
import { PLATFORM_REFRESH_COOKIE } from './platform.cookies';
import { PlatformLoginDto, PlatformMfaDto, PlatformMfaEnrollConfirmDto, PlatformSetPasswordDto } from './dto/platform.dto';

const refreshCookie = (req: Request): string | undefined =>
  (req.cookies as Record<string, string> | undefined)?.[PLATFORM_REFRESH_COOKIE];

/**
 * Vendor-console auth (blueprint §24). `@Public` so the tenant guard chain
 * (Csrf/Jwt/TenantScope) is skipped — these routes carry no tenant. Protected routes
 * add PlatformAuthGuard explicitly. Login reuses the `login` rate-limit policy (§29).
 */
@Public()
@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  @RateLimit('login')
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: PlatformLoginDto, @Res({ passthrough: true }) res: Response) {
    return this.auth.login(dto, res);
  }

  /** Step 2 of the two-step login (SA0). `@Public` (no session yet); the mfaToken carries identity. */
  @RateLimit('login')
  @Post('mfa')
  @HttpCode(HttpStatus.OK)
  mfa(@Body() dto: PlatformMfaDto, @Res({ passthrough: true }) res: Response) {
    return this.auth.mfa(dto, res);
  }

  /** Begin MFA enrolment for the signed-in operator — returns the otpauth URL + raw secret (SA0). */
  @UseGuards(PlatformAuthGuard)
  @Post('mfa/enroll/begin')
  @HttpCode(HttpStatus.OK)
  mfaEnrollBegin(@CurrentPlatformUser() actor: PlatformActor) {
    return this.auth.mfaEnrollBegin(actor.id);
  }

  /** Confirm enrolment with a TOTP — returns the one-time recovery codes (SA0). */
  @UseGuards(PlatformAuthGuard)
  @Post('mfa/enroll/confirm')
  @HttpCode(HttpStatus.OK)
  mfaEnrollConfirm(@CurrentPlatformUser() actor: PlatformActor, @Body() dto: PlatformMfaEnrollConfirmDto) {
    return this.auth.mfaEnrollConfirm(actor.id, dto);
  }

  /** Public: an INVITED operator sets their own password via the one-time onboarding token (SA4b). */
  @Post('set-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async setPassword(@Body() dto: PlatformSetPasswordDto) {
    await this.auth.setPassword(dto);
  }

  @RateLimit('refresh')
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.refresh(refreshCookie(req), res);
  }

  @UseGuards(PlatformAuthGuard)
  @Get('me')
  me(@CurrentPlatformUser() actor: PlatformActor) {
    return this.auth.me(actor.id);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(refreshCookie(req), res);
  }
}
