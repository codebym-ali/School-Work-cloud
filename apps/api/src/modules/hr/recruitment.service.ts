import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, VacancyStatus } from '@prisma/client';
import {
  AppError, assertCampusAccess, AuditActions, effectiveCampusFilter, ErrorCodes, TenantContext,
} from '@common';
import { AuditService, TenantPrismaService } from '@database';
import type { CreateVacancyDto, ListVacancyQuery } from './dto/hr.dto';

/**
 * Recruitment (HR module, blueprint §13 extension). A vacancy is a job opening at a campus
 * and the entry point of the hiring workflow. Campus scoping is enforced: a campus-bound
 * user can only create/read/close vacancies in their own campus (§22.8). Every create and
 * close writes an AuditLog (who + when + old→new), per the HR audit requirement.
 */
@Injectable()
export class RecruitmentService {
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

  async create(dto: CreateVacancyDto) {
    // A campus-bound admin can only post a vacancy for their own campus.
    assertCampusAccess(this.ctx.user, dto.campusId);
    const campus = await this.db.campus.findFirst({ where: { id: dto.campusId }, select: { id: true } });
    if (!campus) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Campus not found');

    const vacancy = await this.db.vacancy.create({
      data: {
        schoolId: this.sid,
        campusId: dto.campusId,
        title: dto.title.trim(),
        department: dto.department.trim(),
        description: dto.description.trim(),
        employmentType: dto.employmentType,
        positions: dto.positions,
        status: VacancyStatus.OPEN,
        createdById: this.ctx.user!.userId,
      },
      include: { campus: { select: { name: true } } },
    });
    await this.audit.record({
      action: AuditActions.VACANCY_CREATED,
      entityType: 'Vacancy',
      entityId: vacancy.id,
      newValue: { title: vacancy.title, department: vacancy.department, campusId: vacancy.campusId, positions: vacancy.positions, employmentType: vacancy.employmentType },
    });
    return this.shape(vacancy);
  }

  async list(q: ListVacancyQuery) {
    // Campus-bound users are forced to their own campus (client campusId ignored).
    const campusId = effectiveCampusFilter(this.ctx.user, q.campusId);
    const rows = await this.db.vacancy.findMany({
      where: {
        ...(campusId ? { campusId } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.department ? { department: q.department } : {}),
      },
      include: { campus: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((v) => this.shape(v));
  }

  async close(id: string) {
    const vacancy = await this.getScoped(id);
    if (vacancy.status === VacancyStatus.CLOSED) {
      throw new AppError(ErrorCodes.INVALID_STATE_TRANSITION, HttpStatus.CONFLICT, 'Vacancy is already closed');
    }
    const updated = await this.db.vacancy.update({
      where: { id },
      data: { status: VacancyStatus.CLOSED, closedAt: new Date() },
      include: { campus: { select: { name: true } } },
    });
    await this.audit.record({
      action: AuditActions.VACANCY_CLOSED,
      entityType: 'Vacancy',
      entityId: id,
      oldValue: { status: vacancy.status },
      newValue: { status: VacancyStatus.CLOSED },
    });
    return this.shape(updated);
  }

  /** Fetch a vacancy, asserting the caller's campus owns it (RLS already scopes by school). */
  private async getScoped(id: string) {
    const vacancy = await this.db.vacancy.findFirst({ where: { id } });
    if (!vacancy) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Vacancy not found');
    assertCampusAccess(this.ctx.user, vacancy.campusId);
    return vacancy;
  }

  private shape(v: Prisma.VacancyGetPayload<{ include: { campus: { select: { name: true } } } }>) {
    return {
      id: v.id, campusId: v.campusId, campusName: v.campus?.name ?? null,
      title: v.title, department: v.department, description: v.description,
      employmentType: v.employmentType, positions: v.positions, status: v.status,
      closedAt: v.closedAt, createdAt: v.createdAt,
    };
  }
}
