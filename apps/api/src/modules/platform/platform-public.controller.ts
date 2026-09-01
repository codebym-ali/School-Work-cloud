import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Post, Query, Inject } from '@nestjs/common';
import { Public, ENV, type Env } from '@common';
import { PrismaService } from '@database';
import { PlatformBillingService } from './platform-billing.service';
import { PlatformLeadsService } from './platform-leads.service';
import { DemoRequestDto } from './dto/platform.dto';

/**
 * Public, UNAUTHENTICATED vendor endpoints (SA6d / SA8) — the marketing landing page reads the list
 * price here and submits demo requests here. `@Public()` skips the tenant guard chain and there is no
 * PlatformAuthGuard, so these are open to anyone on any host (the apex marketing site included). Only
 * non-sensitive advertised data (the price) is READ here; the WRITE (a lead) is inbound-only.
 */
@Public()
@Controller('platform/public')
export class PlatformPublicController {
  constructor(
    private readonly billing: PlatformBillingService,
    private readonly leads: PlatformLeadsService,
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** The single public per-student "list" price shown on the marketing site. */
  @Get('pricing')
  pricing() {
    return this.billing.getPublicPricing();
  }

  /**
   * Capture a demo/contact request from the marketing site (SA8). Public — no session, no CSRF token
   * (the CsrfGuard skips @Public + sessionless requests). The `website` field is a honeypot: a real
   * visitor never sees it, so if it's filled we accept the request (200) but save nothing.
   */
  @Post('demo-request')
  @HttpCode(HttpStatus.CREATED)
  demoRequest(@Body() dto: DemoRequestDto) {
    if (dto.website) return { ok: true };
    return this.leads.createLead({
      name: dto.name,
      email: dto.email,
      schoolName: dto.schoolName,
      phone: dto.phone,
      studentCount: dto.studentCount,
      message: dto.message,
    });
  }

  /**
   * On-demand TLS gate for the reverse proxy (Front-End Instance Separation Plan, Phase 4). Caddy's
   * `on_demand_tls { ask ... }` calls this with `?domain=<hostname>` before minting a certificate;
   * a 2xx = "issue it", anything else = "refuse". We allow ONLY hosts we actually serve so junk hosts
   * can't make us request certs (abuse + Let's-Encrypt rate limits): the apex, the reserved console
   * subdomains, a bare `<school>.<apex>`, a role host `<role>.<school>.<apex>`, or a school custom
   * domain — where `<school>` is a real tenant. (Existence only, not active: a suspended school's host
   * still needs TLS to show its suspended page.)
   */
  @Get('host-allowed')
  async hostAllowed(@Query('domain') domain?: string) {
    if (!(await this.isHostAllowed(domain ?? ''))) {
      throw new NotFoundException('host not served');
    }
    return { ok: true };
  }

  private async isHostAllowed(rawHost: string): Promise<boolean> {
    const host = rawHost.split(':')[0].toLowerCase();
    if (!host) return false;
    const apex = this.env.APP_APEX_DOMAIN.split(':')[0].toLowerCase();
    const reservedConsole = new Set(['superadmin', 'admin', 'www']);
    const roleLabels = new Set(['owner', 'staff', 'student']);
    const exists = async (where: { subdomain: string } | { customDomain: string }) =>
      !!(await this.prisma.school.findFirst({ where, select: { id: true } }));

    if (host === apex) return true;
    if (!host.endsWith(`.${apex}`)) return exists({ customDomain: host }); // a school's custom domain

    const labels = host.slice(0, host.length - apex.length - 1).split('.'); // labels before the apex
    if (labels.length === 1) {
      return reservedConsole.has(labels[0]) || exists({ subdomain: labels[0] });
    }
    if (labels.length === 2 && roleLabels.has(labels[0])) {
      return exists({ subdomain: labels[1] }); // <role>.<school>.<apex>
    }
    return false;
  }
}
