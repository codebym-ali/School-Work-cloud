import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '@common';
import { PlatformLeadsService } from './platform-leads.service';
import { PlatformAuthGuard, PlatformRoles, CurrentPlatformUser, type PlatformActor } from './platform-auth.guard';
import { ListLeadsQuery, UpdateLeadDto } from './dto/platform.dto';

/**
 * The console leads inbox (SA8) — working the demo/contact requests captured from the marketing site.
 * A customer-facing function, so it is confined to SUPER_ADMIN + SUPPORT (BILLING/ANALYST are out).
 * `@Public` skips the tenant guard chain (no tenant here); PlatformAuthGuard enforces the platform
 * session (+ CSRF on writes). Runs on the platform_admin BYPASSRLS connection.
 */
@Public()
@UseGuards(PlatformAuthGuard)
@Controller('platform/leads')
export class PlatformLeadsController {
  constructor(private readonly leads: PlatformLeadsService) {}

  @PlatformRoles('SUPER_ADMIN', 'SUPPORT')
  @Get()
  list(@Query() q: ListLeadsQuery) {
    return this.leads.listLeads(q);
  }

  @PlatformRoles('SUPER_ADMIN', 'SUPPORT')
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  update(@Param('id') id: string, @Body() dto: UpdateLeadDto, @CurrentPlatformUser() actor: PlatformActor, @Req() req: Request) {
    return this.leads.updateLead(id, dto, { platformUserId: actor.id, ip: req.ip });
  }
}
