import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Public } from '@common';
import { PlatformService } from './platform.service';
import { PlatformAuthGuard } from './platform-auth.guard';
import { ListTenantsQuery, ProvisionTenantDto } from './dto/platform.dto';

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
  listTenants(@Query() q: ListTenantsQuery) {
    return this.platform.listTenants(q);
  }

  @Post('tenants')
  @HttpCode(HttpStatus.CREATED)
  provision(@Body() dto: ProvisionTenantDto) {
    return this.platform.provisionTenant(dto);
  }

  @Post('tenants/:id/suspend')
  @HttpCode(HttpStatus.OK)
  suspend(@Param('id', ParseUUIDPipe) id: string) {
    return this.platform.suspend(id);
  }

  @Post('tenants/:id/reactivate')
  @HttpCode(HttpStatus.OK)
  reactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.platform.reactivate(id);
  }
}
