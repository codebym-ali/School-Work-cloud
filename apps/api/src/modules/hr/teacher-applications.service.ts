import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError, assertCampusAccess, AuditActions, effectiveCampusFilter, ErrorCodes, TenantContext,
} from '@common';
import { AuditService, TenantPrismaService } from '@database';
import type { CreateTeacherApplicationDto, ListTeacherApplicationQuery } from './dto/teacher-application.dto';

/**
 * Teacher applications (HR module). The dedicated Add-Teacher form: queryable fields are
 * columns; the rest of the form (personal, contact, education, experience, skills) persists
 * in `details`. Campus-scoped (§22.8) and audited.
 */
@Injectable()
export class TeacherApplicationsService {
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

  async create(dto: CreateTeacherApplicationDto) {
    assertCampusAccess(this.ctx.user, dto.campusId);
    const campus = await this.db.campus.findFirst({ where: { id: dto.campusId }, select: { id: true } });
    if (!campus) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Campus not found');

    const app = await this.db.teacherApplication.create({
      data: {
        schoolId: this.sid,
        campusId: dto.campusId,
        fullName: dto.fullName.trim(),
        email: dto.email.toLowerCase().trim(),
        mobile: dto.mobile.trim(),
        positionAppliedFor: dto.positionAppliedFor.trim(),
        department: dto.department.trim(),
        employmentType: dto.employmentType,
        expectedSalary: dto.expectedSalary ?? null,
        availableJoiningDate: dto.availableJoiningDate ? new Date(dto.availableJoiningDate) : null,
        details: dto.details as unknown as Prisma.InputJsonValue,
        createdById: this.ctx.user!.userId,
      },
      include: { campus: { select: { name: true } } },
    });
    await this.audit.record({
      action: AuditActions.TEACHER_APPLICATION_CREATED,
      entityType: 'TeacherApplication',
      entityId: app.id,
      newValue: { fullName: app.fullName, positionAppliedFor: app.positionAppliedFor, campusId: app.campusId },
    });
    return this.shapeSummary(app);
  }

  async list(q: ListTeacherApplicationQuery) {
    const campusId = effectiveCampusFilter(this.ctx.user, q.campusId);
    const search = q.search?.trim();
    const rows = await this.db.teacherApplication.findMany({
      where: {
        ...(campusId ? { campusId } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(search
          ? { OR: [
              { fullName: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
              { mobile: { contains: search } },
            ] }
          : {}),
      },
      include: { campus: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.shapeSummary(r));
  }

  async getOne(id: string) {
    const app = await this.db.teacherApplication.findFirst({
      where: { id },
      include: { campus: { select: { name: true } } },
    });
    if (!app) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Application not found');
    assertCampusAccess(this.ctx.user, app.campusId);
    return { ...this.shapeSummary(app), details: app.details };
  }

  private shapeSummary(a: Prisma.TeacherApplicationGetPayload<{ include: { campus: { select: { name: true } } } }>) {
    return {
      id: a.id, campusId: a.campusId, campusName: a.campus?.name ?? null,
      fullName: a.fullName, email: a.email, mobile: a.mobile,
      positionAppliedFor: a.positionAppliedFor, department: a.department,
      employmentType: a.employmentType,
      expectedSalary: a.expectedSalary ? a.expectedSalary.toString() : null,
      availableJoiningDate: a.availableJoiningDate, status: a.status, createdAt: a.createdAt,
    };
  }
}
