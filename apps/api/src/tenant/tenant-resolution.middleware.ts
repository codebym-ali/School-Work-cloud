import { HttpStatus, Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { CLS_KEYS, ENV, ErrorCodes, type Env } from '@common';
import { PrismaService } from '@database';

interface CachedTenant {
  id: string;
  planTier: string;
  isActive: boolean;
  expiresAt: number;
}

/**
 * Resolves the tenant from the Host header BEFORE auth (blueprint §19 step 1, §21.1),
 * so /auth/login works. Sets cls.schoolId + cls.planTier.
 *
 * Resolution order: (1) exact custom_domain; (2) first label as subdomain when the
 * host is under the platform apex; (3) otherwise 404. Reserved labels never resolve.
 * Suspended tenant => 403 TENANT_SUSPENDED (truthful, not 404).
 *
 * Cache: a 60s in-process TTL cache keyed by host. NOTE: the blueprint specifies a
 * Redis cache with an explicit DEL on suspend/reactivate/domain-change so a suspend
 * takes effect within one request. Swapping this Map for Redis + event-driven
 * invalidation is a tracked M1 follow-up; correctness holds today because the TTL is
 * short and isActive is re-checked every request.
 */
@Injectable()
export class TenantResolutionMiddleware implements NestMiddleware {
  private static readonly cache = new Map<string, CachedTenant>();
  private readonly apexHost: string;
  private readonly reserved: Set<string>;

  constructor(
    private readonly cls: ClsService,
    private readonly prisma: PrismaService,
    @Inject(ENV) env: Env,
  ) {
    this.apexHost = env.APP_APEX_DOMAIN.split(':')[0].toLowerCase();
    this.reserved = new Set(env.RESERVED_SUBDOMAINS);
  }

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Capture request metadata for audit trails (§31) while we have the request.
    this.cls.set(CLS_KEYS.ip, req.ip);
    this.cls.set(CLS_KEYS.userAgent, req.headers['user-agent']);
    const host = (req.headers.host ?? '').split(':')[0].toLowerCase();
    const tenant = await this.resolve(host);
    // Errors thrown in middleware bypass Nest's exception filter, so we emit the
    // standard error envelope (§25.1) directly here rather than throwing.
    if (!tenant) {
      this.deny(res, HttpStatus.NOT_FOUND, ErrorCodes.TENANT_NOT_FOUND, 'Unknown tenant');
      return;
    }
    if (!tenant.isActive) {
      this.deny(res, HttpStatus.FORBIDDEN, ErrorCodes.TENANT_SUSPENDED, 'Tenant suspended');
      return;
    }
    this.cls.set(CLS_KEYS.schoolId, tenant.id);
    this.cls.set(CLS_KEYS.planTier, tenant.planTier);
    next();
  }

  private deny(res: Response, status: number, code: string, message: string): void {
    res.status(status).json({ error: { code, message, requestId: this.cls.getId() } });
  }

  private async resolve(host: string): Promise<CachedTenant | null> {
    if (!host) return null;

    const cached = TenantResolutionMiddleware.cache.get(host);
    if (cached && cached.expiresAt > Date.now()) return cached;

    const subdomain = this.subdomainOf(host);
    if (subdomain && this.reserved.has(subdomain)) return null;

    // (1) exact custom domain, then (2) subdomain.
    const school = await this.prisma.school.findFirst({
      where: {
        OR: [{ customDomain: host }, ...(subdomain ? [{ subdomain }] : [])],
      },
      select: { id: true, planTier: true, isActive: true },
    });
    if (!school) return null;

    const entry: CachedTenant = {
      id: school.id,
      planTier: school.planTier,
      isActive: school.isActive,
      expiresAt: Date.now() + 60_000,
    };
    TenantResolutionMiddleware.cache.set(host, entry);
    return entry;
  }

  private subdomainOf(host: string): string | null {
    if (host === this.apexHost) return null;
    if (host.endsWith(`.${this.apexHost}`)) {
      return host.slice(0, host.length - this.apexHost.length - 1).split('.')[0];
    }
    return null;
  }

  /** Test/ops hook: drop a host from the cache (mirrors the Redis DEL the blueprint mandates). */
  static invalidate(host: string): void {
    TenantResolutionMiddleware.cache.delete(host);
  }
}
