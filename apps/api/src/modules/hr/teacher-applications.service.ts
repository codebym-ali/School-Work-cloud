import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma, TeacherApplicationStatus } from '@prisma/client';
import {
  AppError, assertCampusAccess, AuditActions, effectiveCampusFilter, ErrorCodes,
  FIELD_ENCRYPTION, FieldEncryption, TenantContext,
} from '@common';
import { AuditService, TenantPrismaService } from '@database';
import { AccessService } from '../access/access.service';
import { StaffService } from './staff.service';
import type {
  CreateTeacherApplicationDto,
  HireApplicantDto,
  ListTeacherApplicationQuery,
  UpdateApplicationStatusDto,
} from './dto/teacher-application.dto';

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
    private readonly staff: StaffService,
    private readonly access: AccessService,
    @Inject(FIELD_ENCRYPTION) private readonly crypto: FieldEncryption,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }
  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  async create(dto: CreateTeacherApplicationDto) {
    await this.access.assert('recruitment.applications');
    assertCampusAccess(this.ctx.user, dto.campusId);
    const campus = await this.db.campus.findFirst({ where: { id: dto.campusId }, select: { id: true } });
    if (!campus) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Campus not found');

    // The CNIC is a national ID. Pull it OUT of the JSON blob and store it encrypted in its
    // own column — a blob cannot be selectively protected, and ParentProfile already treats
    // the same data class this way. `details` is persisted without it.
    const { cnic, ...detailsWithoutCnic } = (dto.details ?? {}) as Record<string, unknown>;

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
        details: detailsWithoutCnic as unknown as Prisma.InputJsonValue,
        cnicEnc: typeof cnic === 'string' && cnic.trim() ? this.crypto.encrypt(cnic.trim()) : null,
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
    // Encrypted fields are write-only here (nothing in the codebase decrypts a CNIC), so the
    // reader gets a flag rather than the value — and rather than silence, which would suggest
    // it was never captured.
    return { ...this.shapeSummary(app), details: app.details, hasCnic: Boolean(app.cnicEnc) };
  }

  /**
   * Advance an application to SHORTLISTED or REJECTED. Terminal states (REJECTED, HIRED)
   * can't be changed; HIRED is only reachable via `hire()`. Campus-scoped + audited.
   */
  async updateStatus(id: string, dto: UpdateApplicationStatusDto) {
    await this.access.assert('recruitment.applications');
    const app = await this.getScoped(id);
    assertOpen(app.status);
    if (app.status === dto.status) {
      throw new AppError(ErrorCodes.INVALID_STATE_TRANSITION, HttpStatus.CONFLICT, `Application is already ${dto.status}`);
    }
    const updated = await this.db.teacherApplication.update({
      where: { id },
      data: { status: dto.status as TeacherApplicationStatus },
      include: { campus: { select: { name: true } } },
    });
    await this.audit.record({
      action: AuditActions.TEACHER_APPLICATION_STATUS_CHANGED,
      entityType: 'TeacherApplication',
      entityId: id,
      oldValue: { status: app.status },
      newValue: { status: dto.status, reason: dto.reason ?? null },
    });
    return this.shapeSummary(updated);
  }

  /**
   * Hire an applicant: create the staff User (INVITED) + StaffProfile from the application
   * and mark it HIRED. Runs inside the request's withTenant tx, so account creation and the
   * status flip commit together (or roll back together). Campus comes from the application.
   */
  async hire(id: string, dto: HireApplicantDto) {
    await this.access.assert('recruitment.hire');
    const app = await this.getScoped(id);
    assertOpen(app.status);

    const created = await this.staff.createStaff({
      email: app.email,
      staffType: dto.staffType ?? 'TEACHER',
      employeeCode: dto.employeeCode,
      designation: dto.designation?.trim() || app.positionAppliedFor,
      joinedAt: dto.joinedAt ?? new Date().toISOString(),
      campusId: app.campusId,
    });

    const updated = await this.db.teacherApplication.update({
      where: { id },
      data: { status: TeacherApplicationStatus.HIRED },
      include: { campus: { select: { name: true } } },
    });
    await this.audit.record({
      action: AuditActions.TEACHER_APPLICATION_HIRED,
      entityType: 'TeacherApplication',
      entityId: id,
      oldValue: { status: app.status },
      newValue: { status: TeacherApplicationStatus.HIRED, staffId: created.staffId, userId: created.userId },
    });
    return { ...this.shapeSummary(updated), staff: created };
  }

  /** Fetch an application, asserting the caller's campus owns it (RLS scopes by school). */
  private async getScoped(id: string) {
    const app = await this.db.teacherApplication.findFirst({ where: { id } });
    if (!app) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Application not found');
    assertCampusAccess(this.ctx.user, app.campusId);
    return app;
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

/** An application can only be acted on while still open (SUBMITTED or SHORTLISTED). */
function assertOpen(status: TeacherApplicationStatus): void {
  if (status === TeacherApplicationStatus.HIRED || status === TeacherApplicationStatus.REJECTED) {
    throw new AppError(
      ErrorCodes.INVALID_STATE_TRANSITION,
      HttpStatus.CONFLICT,
      `Application is ${status} and can no longer change`,
    );
  }
}
