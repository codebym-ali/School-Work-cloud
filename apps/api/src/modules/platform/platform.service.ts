import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma, type PlanTier, type PlatformRole } from '@prisma/client';
import { AppError, ENV, ErrorCodes, paginate, toSkipTake, type Env, type Paginated } from '@common';
import { PlatformPrismaService, purgeTenant, exportTenant } from '@database';
import { TenantResolutionMiddleware } from '../../tenant/tenant-resolution.middleware';
import { ProvisioningService } from './provisioning.service';
import { PlatformAuditService } from './platform-audit.service';
import { TokenService } from '../auth/token.service';
import { PLAN_LIMITS, type PlanLimits } from './plan-limits';
import type { CreateOperatorDto, ListTenantsQuery, ProvisionTenantDto } from './dto/platform.dto';

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
  /** SA7: set when scheduled for termination — the instant the hard-delete becomes allowed. */
  purgeAfter: Date | null;
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

/** How long an operator onboarding link stays valid (SA4b) — 7 days, like the tenant SA2 onboarding
 *  link (delivered-then-acted, single-use + hashed). */
const OPERATOR_ONBOARDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** SA7: how long a scheduled-for-termination tenant stays recoverable before the hard-delete becomes
 *  allowed (SA-P5). 30 days — enough for a school to reconsider or retrieve its export. */
const TERMINATION_RETENTION_DAYS = 30;

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
    private readonly tokens: TokenService,
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
          purgeAfter: true,
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
      purgeAfter: s.purgeAfter,
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

  /**
   * Invite a new operator (SA4b, SUPER_ADMIN): create them INVITED with NO password + a one-time
   * onboarding token (SA-P3 — no password is typed into the console), audited `OPERATOR_CREATE`. The
   * email is lowercased to match the login lookup (`email.toLowerCase()`), or an operator could be
   * created that can never sign in.
   */
  async createOperator(dto: CreateOperatorDto, ctx: PlatformActionContext): Promise<{ id: string; email: string; onboardingToken: string }> {
    const email = dto.email.toLowerCase();
    const existing = await this.platform.platformUser.findUnique({ where: { email } });
    if (existing) throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'An operator with that email already exists');
    const operator = await this.platform.platformUser.create({
      data: { email, name: dto.name ?? '', role: dto.role, status: 'INVITED', passwordHash: null },
    });
    const raw = randomBytes(32).toString('base64url');
    await this.platform.platformPasswordResetToken.create({
      data: { platformUserId: operator.id, tokenHash: TokenService.hashRefresh(raw), expiresAt: new Date(Date.now() + OPERATOR_ONBOARDING_TTL_MS) },
    });
    await this.audit.record({
      platformUserId: ctx.platformUserId,
      action: 'OPERATOR_CREATE',
      metadata: { operatorId: operator.id, email, role: dto.role },
      ip: ctx.ip,
    });
    return { id: operator.id, email, onboardingToken: raw };
  }

  /**
   * Start a break-glass "login-as" session into ONE school (SA5, SUPER_ADMIN or SUPPORT). Issues a
   * short-lived, read-only tenant token scoped to the target school — it rides the normal RLS-bound
   * request path and is confined to that one tenant by TenantScopeGuard + RLS, **never BYPASSRLS**
   * (SA-P8). Audited `BREAK_GLASS_START` with the mandatory reason. The console turns the token into
   * an enter link on the school's own host; the session auto-expires (30 min).
   */
  async startBreakGlass(id: string, reason: string, ctx: PlatformActionContext): Promise<{ schoolId: string; subdomain: string; token: string; expiresAt: string }> {
    const school = await this.platform.school.findUnique({ where: { id }, select: { subdomain: true } });
    if (!school) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Tenant not found');
    const { token, expiresInSec } = this.tokens.signBreakGlass(ctx.platformUserId, id);
    const expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();
    await this.audit.record({
      platformUserId: ctx.platformUserId,
      action: 'BREAK_GLASS_START',
      targetTenantId: id,
      reason,
      metadata: { expiresAt },
      ip: ctx.ip,
    });
    return { schoolId: id, subdomain: school.subdomain, token, expiresAt };
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

  private invalidateHostCache(subdomain: string, customDomain: string | null): void {
    TenantResolutionMiddleware.invalidate(`${subdomain}.${this.apexHost}`);
    if (customDomain) TenantResolutionMiddleware.invalidate(customDomain.toLowerCase());
  }

  // ── Tenant offboarding (SA7) ─────────────────────────────────────────────────

  /** Schedule a REVERSIBLE termination (SA7, SA-P5): suspend the school and start a retention window.
   *  Cancelling before the purge reactivates it. Audited `TENANT_TERMINATE_SCHEDULE`. */
  async scheduleTermination(id: string, reason: string, ctx: PlatformActionContext): Promise<{ id: string; purgeAfter: string }> {
    const school = await this.platform.school.findUnique({ where: { id }, select: { subdomain: true, customDomain: true } });
    if (!school) throw new AppError(ErrorCodes.TENANT_NOT_FOUND, HttpStatus.NOT_FOUND, 'Tenant not found');
    const purgeAfter = new Date(Date.now() + TERMINATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    await this.platform.school.update({
      where: { id },
      data: { purgeAfter, terminationReason: reason, isActive: false, suspendedAt: new Date() },
    });
    this.invalidateHostCache(school.subdomain, school.customDomain);
    await this.audit.record({
      platformUserId: ctx.platformUserId,
      action: 'TENANT_TERMINATE_SCHEDULE',
      targetTenantId: id,
      reason,
      metadata: { purgeAfter: purgeAfter.toISOString() },
      ip: ctx.ip,
    });
    return { id, purgeAfter: purgeAfter.toISOString() };
  }

  /** Cancel a scheduled termination (SA7) — reactivates the school. Audited `TENANT_TERMINATE_CANCEL`. */
  async cancelTermination(id: string, ctx: PlatformActionContext): Promise<{ id: string; isActive: boolean }> {
    const school = await this.platform.school.findUnique({ where: { id }, select: { subdomain: true, customDomain: true, purgeAfter: true } });
    if (!school) throw new AppError(ErrorCodes.TENANT_NOT_FOUND, HttpStatus.NOT_FOUND, 'Tenant not found');
    if (!school.purgeAfter) throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'This tenant is not scheduled for termination');
    await this.platform.school.update({ where: { id }, data: { purgeAfter: null, terminationReason: null, isActive: true, suspendedAt: null } });
    this.invalidateHostCache(school.subdomain, school.customDomain);
    await this.audit.record({ platformUserId: ctx.platformUserId, action: 'TENANT_TERMINATE_CANCEL', targetTenantId: id, ip: ctx.ip });
    return { id, isActive: true };
  }

  /** Export a tenant's data (SA7) — the handover before offboarding, sensitive columns redacted.
   *  Read-only; audited `TENANT_EXPORT`. */
  async exportTenantData(id: string, ctx: PlatformActionContext) {
    const school = await this.platform.school.findUnique({ where: { id }, select: { subdomain: true } });
    if (!school) throw new AppError(ErrorCodes.TENANT_NOT_FOUND, HttpStatus.NOT_FOUND, 'Tenant not found');
    const data = await exportTenant(this.platform, id);
    await this.audit.record({ platformUserId: ctx.platformUserId, action: 'TENANT_EXPORT', targetTenantId: id, metadata: { rowCounts: data.rowCounts }, ip: ctx.ip });
    return { schoolId: id, subdomain: school.subdomain, ...data };
  }

  /**
   * IRREVERSIBLE hard-delete of a tenant (SA7, SA-P5). Refused unless the school was scheduled for
   * termination AND its retention window has elapsed, and the operator retyped the subdomain to
   * confirm. Runs in ONE transaction (all-or-nothing) and is proven zero-orphan by `purgeTenant`.
   * Audited `TENANT_PURGE` with the per-table deleted counts — `platform_audit_logs` carries no
   * `school_id`, so that record survives the deletion as the permanent proof of offboarding.
   */
  async purgeTenantData(id: string, confirmSubdomain: string, ctx: PlatformActionContext): Promise<{ id: string; deleted: Record<string, number> }> {
    const school = await this.platform.school.findUnique({ where: { id }, select: { subdomain: true, purgeAfter: true } });
    if (!school) throw new AppError(ErrorCodes.TENANT_NOT_FOUND, HttpStatus.NOT_FOUND, 'Tenant not found');
    if (!school.purgeAfter || school.purgeAfter > new Date()) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Not scheduled for termination, or the retention window has not elapsed');
    }
    if (confirmSubdomain !== school.subdomain) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Confirmation does not match the subdomain');
    }
    const { deleted } = await this.platform.$transaction((tx) => purgeTenant(tx, id), { timeout: 120_000, maxWait: 15_000 });
    this.invalidateHostCache(school.subdomain, null);
    await this.audit.record({
      platformUserId: ctx.platformUserId,
      action: 'TENANT_PURGE',
      targetTenantId: id,
      metadata: { subdomain: school.subdomain, deleted },
      ip: ctx.ip,
    });
    return { id, deleted };
  }
}
