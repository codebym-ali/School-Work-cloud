import { Body, Controller, Get, HttpCode, HttpStatus, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Public, RateLimit } from '@common';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformAuthGuard, CurrentPlatformUser, type PlatformActor } from './platform-auth.guard';
import { PlatformLoginDto } from './dto/platform.dto';

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

  @UseGuards(PlatformAuthGuard)
  @Get('me')
  me(@CurrentPlatformUser() actor: PlatformActor) {
    return this.auth.me(actor.id);
  }

  @UseGuards(PlatformAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Res({ passthrough: true }) res: Response) {
    this.auth.logout(res);
  }
}
