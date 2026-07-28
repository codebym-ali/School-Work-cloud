import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, Role, StaffType } from '@prisma/client';
import { AppError, assertCampusAccess, AuditActions, ErrorCodes, restrictedCampusId, TenantContext } from '@common';
import { AuditService, TenantPrismaService } from '@database';
import { PasswordService } from '../auth/password.service';
import type { CreateSalaryStructureDto, CreateStaffDto, CreateTeacherAssignmentDto } from './dto/hr.dto';

/** Staff HR (blueprint §13): profiles for all staff types, salary structures, teacher assignments. */
@Injectable()
export class StaffService {
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

  /** Create a User + StaffProfile in one operation. Supplying `password` makes the login
   *  usable straight away; omitting it leaves the account INVITED until a password is set. */
  async createStaff(dto: CreateStaffDto) {
    // A campus-bound admin can only create staff in their own campus (§22.8).
    assertCampusAccess(this.ctx.user, dto.campusId ?? null);
    const roles = dto.roles ?? defaultRoles(dto.staffType);

    // The unique indexes on (school, email) and (school, employeeCode) span SOFT-DELETED rows,
    // but the staff directory hides them — so a removed colleague silently blocks the value and
    // the raw P2002 below could name neither the field nor a record the operator can see.
    // Pre-check instead, and say plainly when the clash is with a removed record.
    const email = dto.email.toLowerCase();
    const [emailOwner, codeOwner] = await Promise.all([
      // Only a LIVE account blocks the address. The unique index is partial
      // (WHERE deleted_at IS NULL), so a removed colleague's email is reusable — this
      // pre-check exists for the message, and must not be stricter than the constraint.
      this.db.user.findFirst({ where: { email, deletedAt: null }, select: { deletedAt: true } }),
      this.db.staffProfile.findFirst({
        where: { employeeCode: dto.employeeCode },
        select: { user: { select: { deletedAt: true } } },
      }),
    ]);
    if (emailOwner) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        HttpStatus.CONFLICT,
        `Someone already uses the email ${email}.`,
        [{ field: 'email', issue: 'duplicate' }],
      );
    }
    if (codeOwner) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        HttpStatus.CONFLICT,
        codeOwner.user?.deletedAt
          ? `Employee code ${dto.employeeCode} still belongs to a removed staff member. Use a different code.`
          : `Employee code ${dto.employeeCode} is already in use.`,
        [{ field: 'employeeCode', issue: codeOwner.user?.deletedAt ? 'taken-by-removed' : 'duplicate' }],
      );
    }

    // With a password the account is ACTIVE and can sign in immediately; without one it stays
    // INVITED (no passwordHash) and an owner has to set a password before the teacher can log in.
    const passwordHash = dto.password ? await this.passwords.hash(dto.password) : null;

    try {
      const user = await this.db.user.create({
        data: {
          schoolId: this.sid,
          email: dto.email.toLowerCase(),
          roles,
          status: passwordHash ? 'ACTIVE' : 'INVITED',
          passwordHash,
          passwordChangedAt: passwordHash ? new Date() : null,
          campusId: dto.campusId,
        },
      });
      const staff = await this.db.staffProfile.create({
        data: {
          schoolId: this.sid,
          userId: user.id,
          staffType: dto.staffType,
          employeeCode: dto.employeeCode,
          fullName: dto.fullName,
          designation: dto.designation,
          joinedAt: new Date(dto.joinedAt),
        },
      });
      return {
        userId: user.id, staffId: staff.id, employeeCode: staff.employeeCode,
        email: user.email, loginActive: Boolean(passwordHash),
      };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Email or employeeCode already exists');
      }
      throw e;
    }
  }

  listStaff(staffType?: StaffType) {
    // Campus-bound users only see staff assigned to their campus (via the User row).
    // Excludes staff whose linked User was removed (soft-deleted) — a removed login
    // should disappear from the directory the same way it does from /users.
    const restricted = restrictedCampusId(this.ctx.user);
    return this.db.staffProfile.findMany({
      where: {
        ...(staffType ? { staffType } : {}),
        user: { deletedAt: null, ...(restricted ? { campusId: restricted } : {}) },
      },
      include: { user: { select: { id: true, email: true, roles: true, status: true, campusId: true, campus: { select: { name: true } } } } },
      orderBy: { employeeCode: 'asc' },
    });
  }

  async getStaff(id: string) {
    const staff = await this.db.staffProfile.findFirst({
      where: { id },
      include: { user: { select: { email: true, roles: true, status: true, campusId: true } } },
    });
    if (!staff) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Staff not found');
    // Gates getStaff readers + createSalaryStructure (which calls this).
    assertCampusAccess(this.ctx.user, staff.user.campusId);
    return staff;
  }

  // ── Salary structures ────────────────────────────────────────────────────────
  async createSalaryStructure(staffId: string, dto: CreateSalaryStructureDto) {
    await this.getStaff(staffId);
    return this.db.salaryStructure.create({
      data: {
        schoolId: this.sid,
        staffId,
        basic: dto.basic,
        allowances: (dto.allowances ?? {}) as Prisma.InputJsonValue,
        fixedDeductions: (dto.deductionsFixed ?? {}) as Prisma.InputJsonValue,
        effectiveFrom: new Date(dto.effectiveFrom),
      },
    });
  }

  listSalaryStructures(staffId: string) {
    const restricted = restrictedCampusId(this.ctx.user);
    return this.db.salaryStructure.findMany({
      where: { staffId, ...(restricted ? { staff: { user: { campusId: restricted } } } : {}) },
      orderBy: { effectiveFrom: 'desc' },
    });
  }

  // ── Teacher assignments ──────────────────────────────────────────────────────
  async createAssignment(dto: CreateTeacherAssignmentDto) {
    await this.getStaff(dto.staffId); // asserts the staff is in the caller's campus
    try {
      return await this.db.teacherAssignment.create({
        data: { schoolId: this.sid, staffId: dto.staffId, academicYearId: dto.academicYearId, sectionId: dto.sectionId, subjectId: dto.subjectId },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Assignment already exists');
      }
      throw e;
    }
  }

  listAssignments(sectionId?: string, staffId?: string) {
    const restricted = restrictedCampusId(this.ctx.user);
    return this.db.teacherAssignment.findMany({
      where: {
        ...(sectionId ? { sectionId } : {}),
        ...(staffId ? { staffId } : {}),
        ...(restricted ? { staff: { user: { campusId: restricted } } } : {}),
      },
    });
  }

  async deleteAssignment(id: string) {
    // Scope the delete so a campus-bound user can't remove another campus's assignment.
    const restricted = restrictedCampusId(this.ctx.user);
    // Read first: after deleteMany the row is gone and the audit could only record an id.
    const before = await this.db.teacherAssignment.findFirst({
      where: { id, ...(restricted ? { staff: { user: { campusId: restricted } } } : {}) },
      select: { staffId: true, sectionId: true, subjectId: true, academicYearId: true },
    });
    const { count } = await this.db.teacherAssignment.deleteMany({
      where: { id, ...(restricted ? { staff: { user: { campusId: restricted } } } : {}) },
    });
    // deleteMany is a no-op when the scope filter excludes the row — don't audit a non-event.
    if (count > 0 && before) {
      await this.audit.record({
        action: AuditActions.TEACHER_ASSIGNMENT_REMOVED,
        entityType: 'TeacherAssignment',
        entityId: id,
        oldValue: before,
      });
    }
  }
}

function defaultRoles(staffType: StaffType): Role[] {
  if (staffType === StaffType.TEACHER) return [Role.TEACHER];
  if (staffType === StaffType.ACCOUNTANT) return [Role.ACCOUNTANT];
  return [Role.STAFF];
}
