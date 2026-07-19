import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  assertCampusAccess,
  AuditActions,
  effectiveCampusFilter,
  ErrorCodes,
  restrictedCampusId,
  TenantContext,
} from '@common';
import { AuditService, TenantPrismaService } from '@database';
import type {
  CreateAcademicYearDto,
  CreateCampusDto,
  CreateClassDto,
  CreateSectionDto,
  CreateSubjectDto,
  UpdateCampusDto,
} from './dto/setup.dto';

/**
 * School setup (blueprint §24 Setup): academic years, campuses, classes, sections,
 * subjects — the structural data admissions/enrollment reference. All reads/writes
 * go through the tenant-bound client (RLS + extension scope every row to the school).
 */
@Injectable()
export class SetupService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly ctx: TenantContext,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  /** Current tenant id — passed explicitly on writes; the extension asserts it matches. */
  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  // ── Academic years ─────────────────────────────────────────────────────────
  async createAcademicYear(dto: CreateAcademicYearDto) {
    const start = new Date(dto.startDate);
    const end = new Date(dto.endDate);
    if (end <= start) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'endDate must be after startDate');
    }
    // Years must not overlap (§7).
    const overlap = await this.db.academicYear.findFirst({
      where: { startDate: { lte: end }, endDate: { gte: start } },
    });
    if (overlap) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, `Overlaps existing year "${overlap.name}"`);
    }
    const year = await this.db.academicYear.create({
      data: { schoolId: this.sid, name: dto.name, startDate: start, endDate: end, isCurrent: false },
    });
    if (dto.isCurrent) await this.setCurrentAcademicYear(year.id);
    return this.db.academicYear.findFirst({ where: { id: year.id } });
  }

  listAcademicYears() {
    return this.db.academicYear.findMany({ orderBy: { startDate: 'desc' } });
  }

  /** Exactly one current year per school (partial unique): unset others, then set this. */
  async setCurrentAcademicYear(id: string) {
    const year = await this.db.academicYear.findFirst({ where: { id } });
    if (!year) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Academic year not found');
    await this.db.academicYear.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
    const updated = await this.db.academicYear.update({ where: { id }, data: { isCurrent: true } });
    await this.audit.record({
      action: AuditActions.ACADEMIC_YEAR_SET_CURRENT,
      entityType: 'AcademicYear',
      entityId: id,
      newValue: { name: year.name },
    });
    return updated;
  }

  /** Resolve the school's current academic year id (used by admissions/enrollment). */
  async requireCurrentYearId(): Promise<string> {
    const year = await this.db.academicYear.findFirst({ where: { isCurrent: true } });
    if (!year) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'No current academic year set');
    }
    return year.id;
  }

  // ── Campuses ───────────────────────────────────────────────────────────────
  async createCampus(dto: CreateCampusDto) {
    const name = dto.name.trim();
    // Campus names are unique per school (case-insensitive) — no two same-named campuses.
    const dup = await this.db.campus.findFirst({ where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true } });
    if (dup) throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, `A campus named "${name}" already exists`);
    return this.db.campus.create({ data: { schoolId: this.sid, name, address: dto.address } });
  }

  /** Delete a campus only when nothing depends on it (no cascade — §17). Blocks with a
   *  clear reason if classes/users/records still belong to it. */
  async deleteCampus(id: string): Promise<void> {
    const campus = await this.db.campus.findFirst({ where: { id }, select: { id: true } });
    if (!campus) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Campus not found');

    const [classes, users] = await Promise.all([
      this.db.class.count({ where: { campusId: id } }),
      this.db.user.count({ where: { campusId: id } }),
    ]);
    const blockers: string[] = [];
    if (classes) blockers.push(`${classes} class(es)`);
    if (users) blockers.push(`${users} user(s)`);
    if (blockers.length) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, `Campus is in use — ${blockers.join(' and ')} still belong to it. Remove or reassign them first.`);
    }

    try {
      await this.db.campus.delete({ where: { id } });
    } catch (e) {
      // Fallback for the rarer references (fee structures, holidays, inquiries, payroll).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') {
        throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Campus is in use by other records (fees, holidays, inquiries or payroll). Remove them first.');
      }
      throw e;
    }
  }

  listCampuses() {
    return this.db.campus.findMany({ orderBy: { name: 'asc' } });
  }

  async updateCampus(id: string, dto: UpdateCampusDto) {
    await this.mustExist('campus', id);
    assertCampusAccess(this.ctx.user, id); // a campus-bound admin may only edit their own campus
    return this.db.campus.update({ where: { id }, data: dto });
  }

  // ── Classes ────────────────────────────────────────────────────────────────
  async createClass(dto: CreateClassDto) {
    await this.mustExist('campus', dto.campusId);
    assertCampusAccess(this.ctx.user, dto.campusId);
    if (dto.minAgeYears != null && dto.maxAgeYears != null && dto.maxAgeYears < dto.minAgeYears) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'maxAgeYears < minAgeYears');
    }
    return this.db.class.create({
      data: {
        schoolId: this.sid,
        campusId: dto.campusId,
        name: dto.name,
        order: dto.order,
        minAgeYears: dto.minAgeYears,
        maxAgeYears: dto.maxAgeYears,
      },
    });
  }

  listClasses(campusId?: string) {
    const effective = effectiveCampusFilter(this.ctx.user, campusId);
    return this.db.class.findMany({
      where: effective ? { campusId: effective } : {},
      orderBy: { order: 'asc' },
    });
  }

  // ── Sections ───────────────────────────────────────────────────────────────
  async createSection(dto: CreateSectionDto) {
    await this.assertClassCampus(dto.classId);
    return this.db.section.create({
      data: { schoolId: this.sid, classId: dto.classId, name: dto.name, capacity: dto.capacity ?? 40 },
    });
  }

  listSections(classId?: string) {
    const restricted = restrictedCampusId(this.ctx.user);
    return this.db.section.findMany({
      where: { ...(classId ? { classId } : {}), ...(restricted ? { class: { campusId: restricted } } : {}) },
      orderBy: { name: 'asc' },
    });
  }

  // ── Subjects ───────────────────────────────────────────────────────────────
  async createSubject(dto: CreateSubjectDto) {
    await this.assertClassCampus(dto.classId);
    return this.db.subject.create({ data: { schoolId: this.sid, classId: dto.classId, name: dto.name } });
  }

  listSubjects(classId?: string) {
    const restricted = restrictedCampusId(this.ctx.user);
    return this.db.subject.findMany({
      where: { ...(classId ? { classId } : {}), ...(restricted ? { class: { campusId: restricted } } : {}) },
      orderBy: { name: 'asc' },
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────────
  /** A class exists and (for campus-bound users) belongs to the caller's campus. */
  private async assertClassCampus(classId: string): Promise<void> {
    const klass = await this.db.class.findFirst({ where: { id: classId }, select: { campusId: true } });
    if (!klass) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'class not found');
    assertCampusAccess(this.ctx.user, klass.campusId);
  }

  private async mustExist(model: 'campus' | 'class' | 'section', id: string): Promise<void> {
    const row = await (this.db[model] as { findFirst: (a: unknown) => Promise<unknown> }).findFirst({
      where: { id },
    });
    if (!row) {
      throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, `${model} not found`);
    }
  }
}
