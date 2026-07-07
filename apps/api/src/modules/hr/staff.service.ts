import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, Role, StaffType } from '@prisma/client';
import { AppError, ErrorCodes, TenantContext } from '@common';
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
    return this.db.staffProfile.findMany({
      where: staffType ? { staffType } : {},
      include: { user: { select: { email: true, roles: true, status: true } } },
      orderBy: { employeeCode: 'asc' },
    });
  }

  async getStaff(id: string) {
    const staff = await this.db.staffProfile.findFirst({
      where: { id },
      include: { user: { select: { email: true, roles: true, status: true } } },
    });
    if (!staff) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Staff not found');
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
    return this.db.salaryStructure.findMany({ where: { staffId }, orderBy: { effectiveFrom: 'desc' } });
  }

  // ── Teacher assignments ──────────────────────────────────────────────────────
  async createAssignment(dto: CreateTeacherAssignmentDto) {
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
    return this.db.teacherAssignment.findMany({
      where: { ...(sectionId ? { sectionId } : {}), ...(staffId ? { staffId } : {}) },
    });
  }

  async deleteAssignment(id: string) {
    await this.db.teacherAssignment.deleteMany({ where: { id } });
  }
}

function defaultRoles(staffType: StaffType): Role[] {
  if (staffType === StaffType.TEACHER) return [Role.TEACHER];
  if (staffType === StaffType.ACCOUNTANT) return [Role.ACCOUNTANT];
  return [Role.STAFF];
}
