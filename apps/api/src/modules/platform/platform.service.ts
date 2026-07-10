import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AppError, ENV, ErrorCodes, type Env } from '@common';
import { PlatformPrismaService } from '@database';
import { TenantResolutionMiddleware } from '../../tenant/tenant-resolution.middleware';
import { ProvisioningService } from './provisioning.service';
import type { ProvisionTenantDto } from './dto/platform.dto';

export interface TenantSummary {
  id: string;
  name: string;
  subdomain: string;
  customDomain: string | null;
  planTier: string;
  isActive: boolean;
  suspendedAt: Date | null;
  createdAt: Date;
  userCount: number;
  studentCount: number;
}

/**
 * Vendor console operations (blueprint §24), executed on the platform_admin (BYPASSRLS)
 * connection so they see every tenant. Suspend/reactivate flip `School.isActive` and
 * immediately invalidate the host-resolution cache so the change takes effect on the
 * very next request (not after the middleware's 60s TTL).
 */
@Injectable()
export class PlatformService {
  private readonly apexHost: string;

  constructor(
    private readonly platform: PlatformPrismaService,
    private readonly provisioning: ProvisioningService,
    @Inject(ENV) env: Env,
  ) {
    this.apexHost = env.APP_APEX_DOMAIN.split(':')[0].toLowerCase();
  }

  /**
   * Provision a new tenant from the console (blueprint §24). Delegates to the shared
   * ProvisioningService (School + first Campus + OWNER_ADMIN, on the BYPASSRLS client);
   * a duplicate subdomain surfaces as 409 CONFLICT from there.
   */
  async provisionTenant(dto: ProvisionTenantDto): Promise<{ id: string; subdomain: string }> {
    const { schoolId } = await this.provisioning.provisionSchool({
      name: dto.name,
      subdomain: dto.subdomain,
      ownerEmail: dto.ownerEmail,
      ownerPassword: dto.ownerPassword,
    });
    return { id: schoolId, subdomain: dto.subdomain.toLowerCase() };
  }

  async listTenants(): Promise<TenantSummary[]> {
    const schools = await this.platform.school.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        subdomain: true,
        customDomain: true,
        planTier: true,
        isActive: true,
        suspendedAt: true,
        createdAt: true,
        _count: { select: { users: true, students: true } },
      },
    });
    return schools.map((s) => ({
      id: s.id,
      name: s.name,
      subdomain: s.subdomain,
      customDomain: s.customDomain,
      planTier: s.planTier,
      isActive: s.isActive,
      suspendedAt: s.suspendedAt,
      createdAt: s.createdAt,
      userCount: s._count.users,
      studentCount: s._count.students,
    }));
  }

  suspend(id: string): Promise<{ id: string; isActive: boolean }> {
    return this.setActive(id, false);
  }

  reactivate(id: string): Promise<{ id: string; isActive: boolean }> {
    return this.setActive(id, true);
  }

  private async setActive(id: string, isActive: boolean): Promise<{ id: string; isActive: boolean }> {
    const school = await this.platform.school.findUnique({ where: { id } });
    if (!school) throw new AppError(ErrorCodes.TENANT_NOT_FOUND, HttpStatus.NOT_FOUND, 'Tenant not found');

    await this.platform.school.update({
      where: { id },
      data: { isActive, suspendedAt: isActive ? null : new Date() },
    });

    // Take effect immediately: drop the tenant-resolution cache for this school's hosts.
    TenantResolutionMiddleware.invalidate(`${school.subdomain}.${this.apexHost}`);
    if (school.customDomain) TenantResolutionMiddleware.invalidate(school.customDomain.toLowerCase());

    return { id, isActive };
  }
}
