import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '@common';
import { PlatformService } from './platform.service';
import { PlatformAuthGuard, PlatformRoles, CurrentPlatformUser, type PlatformActor } from './platform-auth.guard';
import { ListTenantsQuery, ProvisionTenantDto, SuspendTenantDto } from './dto/platform.dto';

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

  // Reads are open to any authenticated operator (SA0 read-only split).
  @Get('tenants')
  listTenants(@Query() q: ListTenantsQuery) {
    return this.platform.listTenants(q);
  }

  // Fleet overview totals (SA1) — a read, so open to any authenticated operator like the list.
  @Get('overview')
  overview() {
    return this.platform.getOverview();
  }

  // Writes require the full operator role (SA0, SA-P6) and leave an audit row (SA-P2).
  @PlatformRoles('SUPER_ADMIN')
  @Post('tenants')
  @HttpCode(HttpStatus.CREATED)
  provision(@Body() dto: ProvisionTenantDto, @CurrentPlatformUser() actor: PlatformActor, @Req() req: Request) {
    return this.platform.provisionTenant(dto, { platformUserId: actor.id, ip: req.ip });
  }

  @PlatformRoles('SUPER_ADMIN')
  @Post('tenants/:id/suspend')
  @HttpCode(HttpStatus.OK)
  suspend(
    @Param('id') id: string,
    @Body() dto: SuspendTenantDto,
    @CurrentPlatformUser() actor: PlatformActor,
    @Req() req: Request,
  ) {
    return this.platform.suspend(id, dto.reason, { platformUserId: actor.id, ip: req.ip });
  }

  @PlatformRoles('SUPER_ADMIN')
  @Post('tenants/:id/reactivate')
  @HttpCode(HttpStatus.OK)
  reactivate(@Param('id') id: string, @CurrentPlatformUser() actor: PlatformActor, @Req() req: Request) {
    return this.platform.reactivate(id, { platformUserId: actor.id, ip: req.ip });
  }
}
