import { Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { Public } from '@common';
import { PlatformService } from './platform.service';
import { PlatformAuthGuard } from './platform-auth.guard';

/**
 * Vendor console (blueprint §24) — cross-tenant tenant management. `@Public` skips the
 * tenant guard chain (no tenant here); PlatformAuthGuard enforces the platform session
 * (+ CSRF on writes). Reads/writes run on the platform_admin BYPASSRLS connection.
 */
@Public()
@UseGuards(PlatformAuthGuard)
@Controller('platform')
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get('tenants')
  listTenants() {
    return this.platform.listTenants();
  }

  @Post('tenants/:id/suspend')
  @HttpCode(HttpStatus.OK)
  suspend(@Param('id') id: string) {
    return this.platform.suspend(id);
  }

  @Post('tenants/:id/reactivate')
  @HttpCode(HttpStatus.OK)
  reactivate(@Param('id') id: string) {
    return this.platform.reactivate(id);
  }
}
