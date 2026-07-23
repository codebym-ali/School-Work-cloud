import { HttpStatus, Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import {
  AppError, AuditActions, ErrorCodes, MODULES, moduleBelongsToRoles, moduleLabel, modulesForRoles, TenantContext,
} from '@common';
import { AuditService, TenantPrismaService } from '@database';

/**
 * Module (functionality) access control (blueprint §23 extension, §22.8 pattern). A granted
 * role unlocks all of its modules by default; the owner can switch a module off for one user.
 * Enforcement runs IN-SERVICE (never a guard) because it reads a tenant row under RLS. OWNER
 * is never restricted — the owner is the one who controls the toggles.
 */
@Injectable()
export class AccessService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }
  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  /** Throw 403 if the calling user has this module switched off. Owners always pass. */
  async assert(moduleKey: string): Promise<void> {
    const user = this.ctx.user;
    if (!user) throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Not authenticated');
    if (user.roles.includes(Role.OWNER_ADMIN)) return;

    const off = await this.db.moduleAccess.findFirst({
      where: { userId: user.userId, moduleKey, allowed: false },
      select: { id: true },
    });
    if (off) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, `The ${moduleLabel(moduleKey)} module is switched off for your account`);
    }
  }

  /** The module keys the CALLING user may currently use, for UI shaping. Owners get every
   *  module; everyone else gets the full catalog minus their switched-off modules (so the
   *  frontend can hide an action the backend would 403). */
  async enabledModulesForSelf(): Promise<string[]> {
    const user = this.ctx.user;
    if (!user) return [];
    const all = MODULES.map((m) => m.key);
    if (user.roles.includes(Role.OWNER_ADMIN)) return all;
    const off = await this.db.moduleAccess.findMany({ where: { userId: user.userId, allowed: false }, select: { moduleKey: true } });
    const offSet = new Set(off.map((o) => o.moduleKey));
    return all.filter((k) => !offSet.has(k));
  }

  /** The modules available to a user (from their roles) with the current on/off state. */
  async listForUser(userId: string) {
    const user = await this.userOr404(userId);
    const catalog = modulesForRoles(user.roles);
    const overrides = await this.db.moduleAccess.findMany({ where: { userId } });
    const state = new Map(overrides.map((o) => [o.moduleKey, o.allowed]));
    return catalog.map((m) => ({
      key: m.key,
      label: m.label,
      description: m.description,
      role: m.role,
      allowed: state.get(m.key) ?? true,
    }));
  }

  /** Owner switches a single module on/off for a user. Find-then-write (no upsert on a tenant model). */
  async setModule(userId: string, moduleKey: string, allowed: boolean) {
    const user = await this.userOr404(userId);
    if (!moduleBelongsToRoles(moduleKey, user.roles)) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'This module does not apply to the user’s roles');
    }
    const existing = await this.db.moduleAccess.findFirst({ where: { userId, moduleKey } });
    if (existing) {
      await this.db.moduleAccess.update({ where: { id: existing.id }, data: { allowed } });
    } else {
      await this.db.moduleAccess.create({ data: { schoolId: this.sid, userId, moduleKey, allowed } });
    }
    await this.audit.record({
      action: AuditActions.MODULE_ACCESS_CHANGED,
      entityType: 'User',
      entityId: userId,
      newValue: { moduleKey, allowed },
    });
    return { userId, moduleKey, allowed };
  }

  private async userOr404(userId: string) {
    const user = await this.db.user.findFirst({ where: { id: userId, deletedAt: null }, select: { id: true, roles: true } });
    if (!user) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'User not found');
    return user;
  }
}
