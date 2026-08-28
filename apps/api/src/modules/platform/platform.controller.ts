import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '@common';
import { PlatformService } from './platform.service';
import { PlatformAuthGuard, PlatformRoles, CurrentPlatformUser, type PlatformActor } from './platform-auth.guard';
import { BreakGlassDto, CreateOperatorDto, ListTenantsQuery, ProvisionTenantDto, PurgeDto, SuspendTenantDto, TerminateDto, UpdateOperatorDto } from './dto/platform.dto';

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


  // Start a break-glass "login-as" session into one school (SA5) — SUPER_ADMIN or SUPPORT; audited,
  // reason required. Returns a short-lived read-only token the console turns into an enter link.
  @PlatformRoles('SUPER_ADMIN', 'SUPPORT')
  @Post('tenants/:id/break-glass')
  @HttpCode(HttpStatus.OK)
  breakGlass(@Param('id') id: string, @Body() dto: BreakGlassDto, @CurrentPlatformUser() actor: PlatformActor, @Req() req: Request) {
    return this.platform.startBreakGlass(id, dto.reason, { platformUserId: actor.id, ip: req.ip });
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

  // ── Tenant offboarding (SA7, SUPER_ADMIN) ────────────────────────────────────
  // Schedule a reversible termination (retention window); audited.
  @PlatformRoles('SUPER_ADMIN')
  @Post('tenants/:id/terminate')
  @HttpCode(HttpStatus.OK)
  terminate(@Param('id') id: string, @Body() dto: TerminateDto, @CurrentPlatformUser() actor: PlatformActor, @Req() req: Request) {
    return this.platform.scheduleTermination(id, dto.reason, { platformUserId: actor.id, ip: req.ip });
  }

  @PlatformRoles('SUPER_ADMIN')
  @Post('tenants/:id/cancel-termination')
  @HttpCode(HttpStatus.OK)
  cancelTermination(@Param('id') id: string, @CurrentPlatformUser() actor: PlatformActor, @Req() req: Request) {
    return this.platform.cancelTermination(id, { platformUserId: actor.id, ip: req.ip });
  }

  // Full data export (redacted) — the handover before offboarding.
  @PlatformRoles('SUPER_ADMIN')
  @Get('tenants/:id/export')
  exportTenant(@Param('id') id: string, @CurrentPlatformUser() actor: PlatformActor, @Req() req: Request) {
    return this.platform.exportTenantData(id, { platformUserId: actor.id, ip: req.ip });
  }

  // IRREVERSIBLE hard-delete — allowed only after the retention window, with a subdomain confirmation (SA-P5).
  @PlatformRoles('SUPER_ADMIN')
  @Post('tenants/:id/purge')
  @HttpCode(HttpStatus.OK)
  purge(@Param('id') id: string, @Body() dto: PurgeDto, @CurrentPlatformUser() actor: PlatformActor, @Req() req: Request) {
    return this.platform.purgeTenantData(id, dto.confirmSubdomain, { platformUserId: actor.id, ip: req.ip });
  }
}
