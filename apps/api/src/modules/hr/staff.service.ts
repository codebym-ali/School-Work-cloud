import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, Role, StaffType } from '@prisma/client';
import { AppError, assertCampusAccess, ErrorCodes, restrictedCampusId, TenantContext } from '@common';
import { TenantPrismaService } from '@database';
import type { CreateSalaryStructureDto, CreateStaffDto, CreateTeacherAssignmentDto } from './dto/hr.dto';

/** Staff HR (blueprint §13): profiles for all staff types, salary structures, teacher assignments. */
@Injectable()
export class StaffService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }
  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  /** Create a User (INVITED, no password) + StaffProfile in one operation. */
  async createStaff(dto: CreateStaffDto) {
    // A campus-bound admin can only create staff in their own campus (§22.8).
    assertCampusAccess(this.ctx.user, dto.campusId ?? null);
    const roles = dto.roles ?? defaultRoles(dto.staffType);
    try {
      const user = await this.db.user.create({
        data: { schoolId: this.sid, email: dto.email.toLowerCase(), roles, status: 'INVITED', campusId: dto.campusId },
      });
      const staff = await this.db.staffProfile.create({
        data: {
          schoolId: this.sid,
          userId: user.id,
          staffType: dto.staffType,
          employeeCode: dto.employeeCode,
          designation: dto.designation,
          joinedAt: new Date(dto.joinedAt),
        },
      });
      return { userId: user.id, staffId: staff.id, employeeCode: staff.employeeCode };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Email or employeeCode already exists');
      }
      throw e;
    }
  }

  listStaff(staffType?: StaffType) {
    // Campus-bound users only see staff assigned to their campus (via the User row).
    const restricted = restrictedCampusId(this.ctx.user);
    return this.db.staffProfile.findMany({
      where: { ...(staffType ? { staffType } : {}), ...(restricted ? { user: { campusId: restricted } } : {}) },
      include: { user: { select: { email: true, roles: true, status: true } } },
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
    await this.db.teacherAssignment.deleteMany({
      where: { id, ...(restricted ? { staff: { user: { campusId: restricted } } } : {}) },
    });
  }
}

function defaultRoles(staffType: StaffType): Role[] {
  if (staffType === StaffType.TEACHER) return [Role.TEACHER];
  if (staffType === StaffType.ACCOUNTANT) return [Role.ACCOUNTANT];
  return [Role.STAFF];
}
