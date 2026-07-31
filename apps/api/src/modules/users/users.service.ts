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

/**
 * "Seat" roles — a campus has exactly one of each, and the holder must be bound to that
 * campus. One principal (CAMPUS_ADMIN) and one admission officer (ADMISSION_CONTROLLER),
 * because both speak for the campus and a second holder makes "who is responsible?"
 * unanswerable. Enforced in the service on every write path AND by a partial unique index
 * per role in 02_partial_uniques.sql.
 */
const SOLE_CAMPUS_SEAT_ROLES: Role[] = [Role.CAMPUS_ADMIN, Role.ADMISSION_CONTROLLER];
const SEAT_LABEL: Record<string, string> = {
  [Role.CAMPUS_ADMIN]: 'a campus admin',
  [Role.ADMISSION_CONTROLLER]: 'an admission officer',
};

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

  // ── The per-campus admission seat (§8/§23) ───────────────────────────────────
  // A campus has exactly ONE admission officer. The seat is the unit of management, so these
  // read/assign/vacate it per campus instead of toggling a capability per person — that is
  // also why a change of holder is one atomic action, not revoke-then-grant from the client
  // (which can half-fail and would trip the unique index between the two calls).

  /**
   * Every campus with its current admission officer (or `null`). Campus-scoped: a campus
   * admin sees only their own. Drives the Admission Portal overview.
   */
  async listAdmissionOfficers() {
    const restricted = restrictedCampusId(this.ctx.user);
    const campuses = await this.db.campus.findMany({
      where: restricted !== null ? { id: restricted } : {},
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    const holders = await this.db.user.findMany({
      where: { deletedAt: null, roles: { has: Role.ADMISSION_CONTROLLER }, campusId: { not: null } },
      select: { id: true, email: true, campusId: true, status: true },
    });
    const byCampus = new Map(holders.map((h) => [h.campusId, h]));
    return campuses.map((c) => {
      const holder = byCampus.get(c.id);
      return {
        campusId: c.id,
        campusName: c.name,
        officer: holder ? { id: holder.id, email: holder.email, status: holder.status } : null,
      };
    });
  }

  /**
   * Give a campus's admission seat to an existing employee of that campus — assigning it
   * when vacant, or handing it over when held. OWNER_ADMIN only.
   *
   * The old holder's role is removed BEFORE the new one is added: uniqueness is checked per
   * statement, so adding first would collide with the outgoing holder on the partial unique
   * index even though the end state is legal.
   */
  async setAdmissionOfficer(campusId: string, userId: string) {
    const campus = await this.db.campus.findFirst({ where: { id: campusId }, select: { id: true, name: true } });
    if (!campus) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Campus not found');

    const next = await this.db.user.findFirst({ where: { id: userId, deletedAt: null } });
    if (!next) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'User not found');
    // The officer must already belong to this campus — the seat is a campus responsibility,
    // and silently re-homing someone would move their other roles' scope too.
    if (next.campusId !== campusId) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        HttpStatus.UNPROCESSABLE_ENTITY,
        `${next.email} does not belong to ${campus.name} — pick someone from this campus, or move them to it first`,
      );
    }

    const current = await this.db.user.findFirst({
      where: { campusId, deletedAt: null, roles: { has: Role.ADMISSION_CONTROLLER } },
      select: { id: true, email: true, roles: true },
    });
    if (current?.id === userId) {
      return { campusId, officer: { id: next.id, email: next.email }, previous: null }; // already holds it
    }

    if (current) {
      await this.db.user.update({
        where: { id: current.id },
        data: { roles: current.roles.filter((r) => r !== Role.ADMISSION_CONTROLLER) },
      });
    }
    const updated = await this.db.user.update({
      where: { id: userId },
      data: { roles: Array.from(new Set([...next.roles, Role.ADMISSION_CONTROLLER])) },
    });

    await this.audit.record({
      action: AuditActions.ADMISSION_OFFICER_ASSIGNED,
      entityType: 'User',
      entityId: userId,
      // Identity, not just ids: the seat's history must stay readable after an account goes.
      oldValue: current ? { campusId, campusName: campus.name, previousOfficer: current.email } : { campusId, campusName: campus.name, previousOfficer: null },
      newValue: { campusId, campusName: campus.name, officer: updated.email },
    });
    return {
      campusId,
      officer: { id: updated.id, email: updated.email },
      previous: current ? { id: current.id, email: current.email } : null,
    };
  }

  /** Vacate a campus's admission seat — the holder keeps their other roles and their login. */
  async removeAdmissionOfficer(campusId: string) {
    const campus = await this.db.campus.findFirst({ where: { id: campusId }, select: { id: true, name: true } });
    if (!campus) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Campus not found');
    const current = await this.db.user.findFirst({
      where: { campusId, deletedAt: null, roles: { has: Role.ADMISSION_CONTROLLER } },
      select: { id: true, email: true, roles: true },
    });
    if (!current) return { campusId, officer: null }; // idempotent — already vacant

    await this.db.user.update({
      where: { id: current.id },
      data: { roles: current.roles.filter((r) => r !== Role.ADMISSION_CONTROLLER) },
    });
    await this.audit.record({
      action: AuditActions.ADMISSION_OFFICER_REMOVED,
      entityType: 'User',
      entityId: current.id,
      oldValue: { campusId, campusName: campus.name, officer: current.email },
      newValue: { officer: null },
    });
    return { campusId, officer: null, removed: { id: current.id, email: current.email } };
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

    if (campusId) {
      for (const seat of SOLE_CAMPUS_SEAT_ROLES.filter((r) => dto.roles.includes(r))) {
        await this.assertSoleCampusSeat(seat, campusId);
      }
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
    // A seat role must keep its campus — dropping it would silently widen the holder's reach.
    for (const seat of SOLE_CAMPUS_SEAT_ROLES.filter((r) => resultingRoles.includes(r))) {
      if (!effectiveCampus) {
        throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, `${SEAT_LABEL[seat]} must belong to a campus`);
      }
      await this.assertSoleCampusSeat(seat, effectiveCampus, id);
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
    // Seat roles (principal, admission officer) are per-campus by definition: they must be
    // bound to one, and only one person may hold each per campus. A campus-LESS holder used
    // to mean school-wide for ADMISSION_CONTROLLER — that is exactly the silent hole this
    // closes, so it is now rejected rather than quietly granting every campus.
    if (grant && SOLE_CAMPUS_SEAT_ROLES.includes(role)) {
      if (!user.campusId) {
        throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, `This employee is not bound to a campus — ${SEAT_LABEL[role]} must belong to one`);
      }
      await this.assertSoleCampusSeat(role, user.campusId, id);
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
   * A campus holds at most ONE of each seat role: one CAMPUS_ADMIN (the principal) and one
   * ADMISSION_CONTROLLER (the admission officer). Throws 409 if another live holder already
   * has this campus. `exceptUserId` skips the user being updated so re-saving the existing
   * holder isn't a false conflict.
   *
   * Must be called from EVERY path that can put a seat role on a campus — `create`,
   * `update` and `grantRole` — because any one of them left unguarded reopens the hole.
   * The DB backs this up with a partial unique index per seat role (02_partial_uniques.sql),
   * so a race between two owners cannot land two holders either.
   */
  private async assertSoleCampusSeat(role: Role, campusId: string, exceptUserId?: string) {
    const existing = await this.db.user.findFirst({
      where: {
        campusId,
        deletedAt: null,
        roles: { has: role },
        ...(exceptUserId ? { id: { not: exceptUserId } } : {}),
      },
      select: { email: true },
    });
    if (!existing) return;
    const message =
      role === Role.ADMISSION_CONTROLLER
        ? `This campus already has an admission officer (${existing.email}). Hand the campus's admission access over to someone else instead of adding a second one.`
        : `This campus already has a campus admin (${existing.email}). Remove or reassign them before adding another.`;
    throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, message);
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
