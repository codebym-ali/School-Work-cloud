import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import {
  AppError,
  assertCampusAccess,
  AuditActions,
  ErrorCodes,
  restrictedCampusId,
  TenantContext,
} from '@common';
import { AuditService, TenantPrismaService } from '@database';
import { PasswordService } from '../auth/password.service';
import { MANAGEABLE_ROLES, type CreateUserDto, type UpdateUserDto } from './dto/users.dto';

/** Roles a CAMPUS_ADMIN may grant (never OWNER_ADMIN/CAMPUS_ADMIN) — §23 "roles ≤ TEACHER/STAFF/ACCOUNTANT". */
const CAMPUS_ADMIN_MAY_GRANT: Role[] = [Role.ACCOUNTANT, Role.TEACHER, Role.STAFF];

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

    const email = dto.email.toLowerCase();
    if (await this.db.user.findFirst({ where: { email }, select: { id: true } })) {
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

  /** Owner sets a new password for a user (e.g. campus admin lost theirs). */
  async resetPassword(id: string, password: string) {
    await this.getOneScoped(id);
    const passwordHash = await this.passwords.hash(password);
    await this.db.user.update({ where: { id }, data: { passwordHash, status: 'ACTIVE' } });
    return { ok: true };
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
