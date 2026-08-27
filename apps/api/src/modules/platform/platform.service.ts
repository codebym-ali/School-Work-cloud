import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma, type PlanTier, type PlatformRole } from '@prisma/client';
import { AppError, ENV, ErrorCodes, paginate, toSkipTake, type Env, type Paginated } from '@common';
import { PlatformPrismaService } from '@database';
import { TenantResolutionMiddleware } from '../../tenant/tenant-resolution.middleware';
import { ProvisioningService } from './provisioning.service';
import { PlatformAuditService } from './platform-audit.service';
import { PLAN_LIMITS, type PlanLimits } from './plan-limits';
import type { ListTenantsQuery, ProvisionTenantDto } from './dto/platform.dto';

/** Who is performing a platform write, and from where — threaded to the audit row (SA-P2). */
export interface PlatformActionContext {
  platformUserId: string;
  ip?: string;
}

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
  /** Current usage for the plan-cap surfacing (SA3): ACTIVE enrollments — the SAME definition as the
   *  fleet dashboard (Law 4), not raw `students` rows (those diverge — the E2E-campus cleanup proved it). */
  activeStudents: number;
}

/** The fleet-overview totals the vendor dashboard reads (SA1). Sourced from the latest nightly
 *  `platform_stats` snapshot; `capturedAt` is null until the first snapshot has been written. */
export interface PlatformOverview {
  capturedAt: string | null;
  schoolsTotal: number;
  schoolsActive: number;
  schoolsSuspended: number;
  studentsActive: number;
  staffEmployed: number;
  newSchools30d: number;
}

/** A vendor operator as the console lists it (SA4) — a password hash never leaves the service. */
export interface OperatorSummary {
  id: string;
  email: string;
  name: string;
  role: PlatformRole;
  status: string;
  mfaEnabled: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
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
    private readonly audit: PlatformAuditService,
    @Inject(ENV) env: Env,
  ) {
    this.apexHost = env.APP_APEX_DOMAIN.split(':')[0].toLowerCase();
  }

  /**
   * Provision a new tenant from the console (blueprint §24). Delegates to the shared
   * ProvisioningService (School + first Campus + OWNER_ADMIN, on the BYPASSRLS client);
   * a duplicate subdomain surfaces as 409 CONFLICT from there. Appends a `TENANT_PROVISION`
   * audit row on success (SA-P2).
   */
  async provisionTenant(dto: ProvisionTenantDto, ctx: PlatformActionContext): Promise<{ id: string; subdomain: string; onboardingToken?: string }> {
    // SA2 (SA-P3): no password is ever passed from the console — provisioning creates an INVITED
    // owner and returns a one-time onboarding token the operator hands over as a set-password link.
    const { schoolId, onboardingToken } = await this.provisioning.provisionSchool({
      name: dto.name,
      subdomain: dto.subdomain,
      ownerEmail: dto.ownerEmail,
    });
    await this.audit.record({
      platformUserId: ctx.platformUserId,
      action: 'TENANT_PROVISION',
      targetTenantId: schoolId,
      metadata: { name: dto.name, subdomain: dto.subdomain.toLowerCase(), ownerEmail: dto.ownerEmail.toLowerCase() },
      ip: ctx.ip,
    });
    return { id: schoolId, subdomain: dto.subdomain.toLowerCase(), onboardingToken };
  }

  async listTenants(q: ListTenantsQuery): Promise<Paginated<TenantSummary>> {
    const search = q.search?.trim();
    const where: Prisma.SchoolWhereInput = search
      ? { OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { subdomain: { contains: search, mode: 'insensitive' } },
        ] }
      : {};
    const { skip, take } = toSkipTake(q);
    const [schools, total] = await Promise.all([
      this.platform.school.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: {
          id: true,
          name: true,
          subdomain: true,
          customDomain: true,
          planTier: true,
          isActive: true,
          suspendedAt: true,
          createdAt: true,
          // ACTIVE enrollments (not raw `students`) so the console's usage matches the dashboard's
          // "Students" definition and the plan cap it is compared against (SA3, Law 4).
          _count: { select: { users: true, enrollments: { where: { status: 'ACTIVE' } } } },
        },
      }),
      this.platform.school.count({ where }),
    ]);
    const data = schools.map((s) => ({
      id: s.id,
      name: s.name,
      subdomain: s.subdomain,
      customDomain: s.customDomain,
      planTier: s.planTier,
      isActive: s.isActive,
      suspendedAt: s.suspendedAt,
      createdAt: s.createdAt,
      userCount: s._count.users,
      activeStudents: s._count.enrollments,
    }));
    return paginate(data, total, q);
  }

  /**
   * The fleet-overview totals for the dashboard (SA1), read from the most recent nightly snapshot
   * (SA-P7 — one server-side definition, O(read one row); never a live fleet-wide COUNT). Returns
   * zeros with `capturedAt: null` before the first snapshot exists, so the UI can say "not run yet"
   * rather than present fabricated numbers.
   */
  async getOverview(): Promise<PlatformOverview> {
    const snap = await this.platform.platformStatsSnapshot.findFirst({ orderBy: { capturedAt: 'desc' } });
    if (!snap) {
      return {
        capturedAt: null,
        schoolsTotal: 0,
        schoolsActive: 0,
        schoolsSuspended: 0,
        studentsActive: 0,
        staffEmployed: 0,
        newSchools30d: 0,
      };
    }
    return {
      capturedAt: snap.capturedAt.toISOString(),
      schoolsTotal: snap.schoolsTotal,
      schoolsActive: snap.schoolsActive,
      schoolsSuspended: snap.schoolsSuspended,
      studentsActive: snap.studentsActive,
      staffEmployed: snap.staffEmployed,
      newSchools30d: snap.newSchools30d,
    };
  }

  /**
   * The plan catalog (SA3) — the per-tier limits straight from the single server-side source
   * (`PLAN_LIMITS`). A read, so open to every operator role; the console renders it and shows each
   * school's usage against its plan's caps. SA3a exposes and assigns plans; enforcing the caps on
   * the tenant request path is SA3b.
   */
  getPlans(): Record<PlanTier, PlanLimits> {
    return PLAN_LIMITS;
  }

  /** Change a tenant's plan (SA3, SUPER_ADMIN); audited as `TENANT_PLAN_CHANGE` with from→to. */
  async changePlan(id: string, planTier: PlanTier, ctx: PlatformActionContext): Promise<{ id: string; planTier: PlanTier }> {
    const school = await this.platform.school.findUnique({ where: { id }, select: { planTier: true } });
    if (!school) throw new AppError(ErrorCodes.TENANT_NOT_FOUND, HttpStatus.NOT_FOUND, 'Tenant not found');
    await this.platform.school.update({ where: { id }, data: { planTier } });
    await this.audit.record({
      platformUserId: ctx.platformUserId,
      action: 'TENANT_PLAN_CHANGE',
      targetTenantId: id,
      metadata: { from: school.planTier, to: planTier },
      ip: ctx.ip,
    });
    return { id, planTier };
  }

  // ── Operator management (SA4) ────────────────────────────────────────────────

  /** List the vendor operators (SA4, SUPER_ADMIN) — the select never includes the password hash. */
  async listOperators(): Promise<OperatorSummary[]> {
    return this.platform.platformUser.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, email: true, name: true, role: true, status: true, mfaEnabled: true, lastLoginAt: true, createdAt: true },
    });
  }

  /**
   * Change an operator's role and/or status (SA4, SUPER_ADMIN); audited as `OPERATOR_UPDATE`.
   *
   * An operator may NOT change their OWN role or status — which also protects the last SUPER_ADMIN
   * for free: disabling or demoting X requires a *different* super-admin to act, so if X is the only
   * one left, nobody can do it. Disabling takes effect on the target's next request (the guard
   * re-checks status live).
   */
  async updateOperator(
    id: string,
    changes: { role?: PlatformRole; status?: 'ACTIVE' | 'DISABLED' },
    ctx: PlatformActionContext,
  ): Promise<OperatorSummary> {
    if (id === ctx.platformUserId) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'You cannot change your own role or status');
    }
    const existing = await this.platform.platformUser.findUnique({ where: { id }, select: { role: true, status: true } });
    if (!existing) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Operator not found');

    const data: Prisma.PlatformUserUpdateInput = {};
    if (changes.role && changes.role !== existing.role) data.role = changes.role;
    if (changes.status && changes.status !== existing.status) data.status = changes.status;

    const updated = await this.platform.platformUser.update({
      where: { id },
      data,
      select: { id: true, email: true, name: true, role: true, status: true, mfaEnabled: true, lastLoginAt: true, createdAt: true },
    });
    await this.audit.record({
      platformUserId: ctx.platformUserId,
      action: 'OPERATOR_UPDATE',
      metadata: {
        operatorId: id,
        ...(data.role ? { role: { from: existing.role, to: changes.role } } : {}),
        ...(data.status ? { status: { from: existing.status, to: changes.status } } : {}),
      },
      ip: ctx.ip,
    });
    return updated;
  }

  /** Suspend a tenant with a mandatory reason (SA-P2); audited as `TENANT_SUSPEND`. */
  async suspend(id: string, reason: string, ctx: PlatformActionContext): Promise<{ id: string; isActive: boolean }> {
    const result = await this.setActive(id, false);
    await this.audit.record({
      platformUserId: ctx.platformUserId,
      action: 'TENANT_SUSPEND',
      targetTenantId: id,
      reason,
      ip: ctx.ip,
    });
    return result;
  }

  /** Reactivate a suspended tenant; audited as `TENANT_REACTIVATE`. */
  async reactivate(id: string, ctx: PlatformActionContext): Promise<{ id: string; isActive: boolean }> {
    const result = await this.setActive(id, true);
    await this.audit.record({
      platformUserId: ctx.platformUserId,
      action: 'TENANT_REACTIVATE',
      targetTenantId: id,
      ip: ctx.ip,
    });
    return result;
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
