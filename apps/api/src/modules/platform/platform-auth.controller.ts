import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public, RateLimit } from '@common';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformAuthGuard, CurrentPlatformUser, type PlatformActor } from './platform-auth.guard';
import { PLATFORM_REFRESH_COOKIE } from './platform.cookies';
import { PlatformLoginDto } from './dto/platform.dto';

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
