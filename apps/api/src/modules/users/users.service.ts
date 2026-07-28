import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import {
  AppError,
  assertCampusAccess,
  type AuditAction,
  AuditActions,
  ErrorCodes,
  restrictedCampusId,
  TenantContext,
} from '@common';
import { AuditService, TenantPrismaService } from '@database';
import { PasswordService } from '../auth/password.service';
import { ACCESS_GRANTABLE_ROLES, MANAGEABLE_ROLES, type CreateUserDto, type UpdateUserDto } from './dto/users.dto';

/** Roles a CAMPUS_ADMIN may grant (never OWNER_ADMIN/CAMPUS_ADMIN) — §23 "roles ≤ TEACHER/STAFF/ACCOUNTANT",
 *  plus ADMISSION_CONTROLLER (the campus's Admission Portal login, provisioned by the campus admin). */
const CAMPUS_ADMIN_MAY_GRANT: Role[] = [Role.ADMISSION_CONTROLLER, Role.ACCOUNTANT, Role.TEACHER, Role.STAFF];

/** Audit action pair (granted, revoked) per access role. HR and campus-admin keep their
 *  specific actions; the rest use the generic role-access pair. */
const ACCESS_AUDIT: Record<string, [AuditAction, AuditAction]> = {
  [Role.HR_MANAGER]: [AuditActions.HR_ACCESS_GRANTED, AuditActions.HR_ACCESS_REVOKED],
  [Role.CAMPUS_ADMIN]: [AuditActions.CAMPUS_ADMIN_GRANTED, AuditActions.CAMPUS_ADMIN_REVOKED],
  [Role.ACCOUNTANT]: [AuditActions.ROLE_ACCESS_GRANTED, AuditActions.ROLE_ACCESS_REVOKED],
  [Role.ADMISSION_CONTROLLER]: [AuditActions.ROLE_ACCESS_GRANTED, AuditActions.ROLE_ACCESS_REVOKED],
};

/**
 * Users & roles (blueprint §23, §22.8). The owner provisions staff/admin logins and binds
 * a campus-bound role to a campus; a campus admin may provision only lower roles within
 * their own campus. Passwords are argon2-hashed; the account is ACTIVE immediately so the
 * user can sign in with the initial password (they can change it later).
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }
  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  /** Staff/admin users, scoped: a campus admin sees only their own campus's users. */
  async list() {
    const restricted = restrictedCampusId(this.ctx.user);
    const where: Prisma.UserWhereInput = { deletedAt: null, roles: { hasSome: MANAGEABLE_ROLES } };
    if (restricted !== null) where.campusId = restricted;
    const users = await this.db.user.findMany({
      where,
      orderBy: { email: 'asc' },
      include: { campus: { select: { name: true } } },
    });
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      roles: u.roles,
      campusId: u.campusId,
      campusName: u.campus?.name ?? null,
      status: u.status,
    }));
  }

  async create(dto: CreateUserDto) {
    const creator = this.ctx.user!;
    const isOwner = creator.roles.includes(Role.OWNER_ADMIN);
    const allowed = isOwner ? MANAGEABLE_ROLES : CAMPUS_ADMIN_MAY_GRANT;
    const forbidden = dto.roles.find((r) => !allowed.includes(r));
    if (forbidden) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, `You are not permitted to grant the role ${forbidden}`);
    }

    // Campus binding: OWNER_ADMIN is school-wide (no campus); every other role needs one.
    let campusId: string | null;
    if (dto.roles.includes(Role.OWNER_ADMIN)) {
      if (dto.campusId) throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'OWNER_ADMIN is school-wide — do not set a campus');
      campusId = null;
    } else {
      const restricted = restrictedCampusId(creator); // a campus admin is forced to their own campus
      campusId = restricted ?? dto.campusId ?? null;
      if (!campusId) throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'A campus is required for this role');
      const campus = await this.db.campus.findFirst({ where: { id: campusId }, select: { id: true } });
      if (!campus) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Campus not found');
      assertCampusAccess(creator, campusId);
    }

    if (dto.roles.includes(Role.CAMPUS_ADMIN) && campusId) {
      await this.assertNoOtherCampusAdmin(campusId);
    }

    const email = dto.email.toLowerCase();
    // Only a LIVE account blocks the address — the unique index is partial
    // (WHERE deleted_at IS NULL), so a removed user's email can be reused.
    if (await this.db.user.findFirst({ where: { email, deletedAt: null }, select: { id: true } })) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'A user with this email already exists');
    }

    const passwordHash = await this.passwords.hash(dto.password);
    const user = await this.db.user.create({
      data: { schoolId: this.sid, email, roles: dto.roles, campusId, passwordHash, status: 'ACTIVE' },
    });
    await this.audit.record({
      action: AuditActions.ROLE_CHANGED,
      entityType: 'User',
      entityId: user.id,
      newValue: { email, roles: dto.roles, campusId, status: 'ACTIVE' },
    });
    return { id: user.id, email: user.email, roles: user.roles, campusId: user.campusId, status: user.status };
  }

  async update(id: string, dto: UpdateUserDto) {
    const user = await this.getOneScoped(id);

    const resultingRoles = dto.roles ?? user.roles;
    const effectiveCampus = dto.campusId !== undefined ? dto.campusId : user.campusId;
    if (resultingRoles.includes(Role.CAMPUS_ADMIN) && effectiveCampus) {
      await this.assertNoOtherCampusAdmin(effectiveCampus, id);
    }

    const data: Prisma.UserUpdateInput = {};
    if (dto.roles) data.roles = dto.roles;
    if (dto.status) data.status = dto.status;
    if (dto.campusId !== undefined) data.campus = { connect: { id_schoolId: { id: dto.campusId, schoolId: this.sid } } };
    const updated = await this.db.user.update({ where: { id }, data });

    if (dto.status === 'DISABLED') {
      await this.audit.record({ action: AuditActions.USER_DISABLED, entityType: 'User', entityId: id, oldValue: { status: user.status }, newValue: { status: 'DISABLED' } });
    } else {
      await this.audit.record({
        action: AuditActions.ROLE_CHANGED,
        entityType: 'User',
        entityId: id,
        oldValue: { roles: user.roles, campusId: user.campusId },
        newValue: { roles: updated.roles, campusId: updated.campusId, status: updated.status },
      });
    }
    return { id: updated.id, email: updated.email, roles: updated.roles, campusId: updated.campusId, status: updated.status };
  }

  /**
   * Set a new password for a user. An owner may reset anyone; a campus admin may reset only
   * their own campus's lower-role logins (e.g. the admission controller) — never a peer
   * campus admin or owner. getOneScoped enforces the campus; the role check enforces the rank.
   */
  async resetPassword(id: string, password: string) {
    const target = await this.getOneScoped(id);
    const creator = this.ctx.user!;
    if (!creator.roles.includes(Role.OWNER_ADMIN)) {
      const forbidden = target.roles.find((r) => !CAMPUS_ADMIN_MAY_GRANT.includes(r));
      if (forbidden) {
        throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, `You are not permitted to reset the password for a ${forbidden}`);
      }
    }
    const passwordHash = await this.passwords.hash(password);
    await this.db.user.update({ where: { id }, data: { passwordHash, status: 'ACTIVE' } });
    return { ok: true };
  }

  /**
   * Remove a user (OWNER_ADMIN only). Soft-delete (sets deletedAt) + disables the account, so
   * they vanish from the directory and can no longer sign in, while records they created (audit
   * trail, vacancies, …) stay intact. Cannot remove yourself or another owner.
   */
  async remove(id: string) {
    const user = await this.getOneScoped(id);
    if (user.id === this.ctx.user!.userId) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'You cannot remove your own account');
    }
    if (user.roles.includes(Role.OWNER_ADMIN)) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Owner accounts cannot be removed');
    }
    await this.db.user.update({ where: { id }, data: { deletedAt: new Date(), status: 'DISABLED' } });
    await this.audit.record({
      action: AuditActions.USER_REMOVED,
      entityType: 'User',
      entityId: id,
      oldValue: { email: user.email, roles: user.roles, status: user.status },
      newValue: { removed: true },
    });
    return { ok: true };
  }

  /**
   * Bulk remove users (OWNER_ADMIN only). Same soft-delete as remove(), applied per id, but
   * unremovable targets (yourself, an owner, another campus, already-gone) are SKIPPED rather
   * than aborting the whole batch. Returns how many were removed vs skipped.
   */
  async removeMany(ids: string[]) {
    const restricted = restrictedCampusId(this.ctx.user);
    const skipped: { id: string; reason: string }[] = [];
    let removed = 0;
    for (const id of Array.from(new Set(ids))) {
      const user = await this.db.user.findFirst({ where: { id, deletedAt: null } });
      if (!user) { skipped.push({ id, reason: 'not found' }); continue; }
      if (restricted !== null && user.campusId !== restricted) { skipped.push({ id, reason: 'another campus' }); continue; }
      if (user.id === this.ctx.user!.userId) { skipped.push({ id, reason: 'self' }); continue; }
      if (user.roles.includes(Role.OWNER_ADMIN)) { skipped.push({ id, reason: 'owner' }); continue; }
      await this.db.user.update({ where: { id }, data: { deletedAt: new Date(), status: 'DISABLED' } });
      await this.audit.record({
        action: AuditActions.USER_REMOVED,
        entityType: 'User',
        entityId: id,
        oldValue: { email: user.email, roles: user.roles, status: user.status },
        newValue: { removed: true, bulk: true },
      });
      removed += 1;
    }
    return { removed, skipped: skipped.length, details: skipped };
  }

  /**
   * Grant/revoke an access capability (HR_MANAGER, CAMPUS_ADMIN, ACCOUNTANT,
   * ADMISSION_CONTROLLER) on an EXISTING employee — OWNER_ADMIN only. The account is reused
   * (no new login); the role is added to / removed from the existing `roles[]`. Single entry
   * point for all access toggles.
   */
  setAccess(id: string, role: Role, grant: boolean) {
    if (!ACCESS_GRANTABLE_ROLES.includes(role)) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, `${role} is not an access-grantable role`);
    }
    const [grantedAction, revokedAction] = ACCESS_AUDIT[role];
    return this.grantRole(id, role, grant, grantedAction, revokedAction);
  }

  /**
   * Add/remove a single role on an EXISTING employee (OWNER_ADMIN only — enforced by the
   * route guard). Reuses the account and preserves every other role, so there is never a
   * duplicate login. CAMPUS_ADMIN additionally requires the employee to be bound to a campus
   * (a principal must belong to one). Idempotent, and audited both ways.
   */
  private async grantRole(id: string, role: Role, grant: boolean, grantedAction: AuditAction, revokedAction: AuditAction) {
    const user = await this.db.user.findFirst({ where: { id, deletedAt: null } });
    if (!user) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'User not found');
    if (grant && role === Role.CAMPUS_ADMIN && !user.campusId) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'This employee is not bound to a campus — a campus admin must belong to one');
    }
    if (grant && role === Role.CAMPUS_ADMIN && user.campusId) {
      await this.assertNoOtherCampusAdmin(user.campusId, id);
    }

    const has = user.roles.includes(role);
    if (has === grant) return { id: user.id, email: user.email, roles: user.roles }; // no-op, idempotent
    const roles = grant ? Array.from(new Set([...user.roles, role])) : user.roles.filter((r) => r !== role);

    const updated = await this.db.user.update({ where: { id }, data: { roles } });
    await this.audit.record({
      action: grant ? grantedAction : revokedAction,
      entityType: 'User',
      entityId: id,
      oldValue: { roles: user.roles },
      newValue: { roles: updated.roles },
    });
    return { id: updated.id, email: updated.email, roles: updated.roles };
  }

  /**
   * A campus may have at most one CAMPUS_ADMIN (the principal). Throws 409 if another
   * active campus admin already holds this campus. `exceptUserId` skips the user being
   * updated so re-saving the existing principal isn't a false conflict.
   */
  private async assertNoOtherCampusAdmin(campusId: string, exceptUserId?: string) {
    const existing = await this.db.user.findFirst({
      where: {
        campusId,
        deletedAt: null,
        roles: { has: Role.CAMPUS_ADMIN },
        ...(exceptUserId ? { id: { not: exceptUserId } } : {}),
      },
      select: { email: true },
    });
    if (existing) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        HttpStatus.CONFLICT,
        `This campus already has a campus admin (${existing.email}). Remove or reassign them before adding another.`,
      );
    }
  }

  private async getOneScoped(id: string) {
    const user = await this.db.user.findFirst({ where: { id, deletedAt: null } });
    if (!user) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'User not found');
    const restricted = restrictedCampusId(this.ctx.user);
    if (restricted !== null && user.campusId !== restricted) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'User belongs to another campus');
    }
    return user;
  }
}
