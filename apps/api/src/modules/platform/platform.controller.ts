import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '@common';
import { PlatformService } from './platform.service';
import { PlatformAuthGuard, PlatformRoles, CurrentPlatformUser, type PlatformActor } from './platform-auth.guard';
import { ChangePlanDto, CreateOperatorDto, ListTenantsQuery, ProvisionTenantDto, SuspendTenantDto, UpdateOperatorDto } from './dto/platform.dto';

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

  // The plan catalog (SA3) — a read, open to any authenticated operator.
  @Get('plans')
  plans() {
    return this.platform.getPlans();
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

  // Change a tenant's plan (SA3, SUPER_ADMIN) — audited as TENANT_PLAN_CHANGE.
  @PlatformRoles('SUPER_ADMIN')
  @Patch('tenants/:id/plan')
  @HttpCode(HttpStatus.OK)
  changePlan(@Param('id') id: string, @Body() dto: ChangePlanDto, @CurrentPlatformUser() actor: PlatformActor, @Req() req: Request) {
    return this.platform.changePlan(id, dto.planTier, { platformUserId: actor.id, ip: req.ip });
  }

  // ── Operator management (SA4) — managing the vendor team is a SUPER_ADMIN function. ──
  @PlatformRoles('SUPER_ADMIN')
  @Get('operators')
  operators() {
    return this.platform.listOperators();
  }

  // Invite a new operator (SA4b) — returns a one-time onboarding token; no password is accepted.
  @PlatformRoles('SUPER_ADMIN')
  @Post('operators')
  @HttpCode(HttpStatus.CREATED)
  createOperator(@Body() dto: CreateOperatorDto, @CurrentPlatformUser() actor: PlatformActor, @Req() req: Request) {
    return this.platform.createOperator(dto, { platformUserId: actor.id, ip: req.ip });
  }

  @PlatformRoles('SUPER_ADMIN')
  @Patch('operators/:id')
  @HttpCode(HttpStatus.OK)
  updateOperator(@Param('id') id: string, @Body() dto: UpdateOperatorDto, @CurrentPlatformUser() actor: PlatformActor, @Req() req: Request) {
    return this.platform.updateOperator(id, dto, { platformUserId: actor.id, ip: req.ip });
  }
}
