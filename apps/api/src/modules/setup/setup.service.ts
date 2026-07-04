import { HttpStatus, Injectable } from '@nestjs/common';
import { AppError, AuditActions, ErrorCodes, TenantContext } from '@common';
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
  createCampus(dto: CreateCampusDto) {
    return this.db.campus.create({ data: { schoolId: this.sid, name: dto.name, address: dto.address } });
  }

  listCampuses() {
    return this.db.campus.findMany({ orderBy: { name: 'asc' } });
  }

  async updateCampus(id: string, dto: UpdateCampusDto) {
    await this.mustExist('campus', id);
    return this.db.campus.update({ where: { id }, data: dto });
  }

  // ── Classes ────────────────────────────────────────────────────────────────
  async createClass(dto: CreateClassDto) {
    await this.mustExist('campus', dto.campusId);
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
    return this.db.class.findMany({
      where: campusId ? { campusId } : {},
      orderBy: { order: 'asc' },
    });
  }

  // ── Sections ───────────────────────────────────────────────────────────────
  async createSection(dto: CreateSectionDto) {
    await this.mustExist('class', dto.classId);
    return this.db.section.create({
      data: { schoolId: this.sid, classId: dto.classId, name: dto.name, capacity: dto.capacity ?? 40 },
    });
  }

  listSections(classId?: string) {
    return this.db.section.findMany({
      where: classId ? { classId } : {},
      orderBy: { name: 'asc' },
    });
  }

  // ── Subjects ───────────────────────────────────────────────────────────────
  async createSubject(dto: CreateSubjectDto) {
    await this.mustExist('class', dto.classId);
    return this.db.subject.create({ data: { schoolId: this.sid, classId: dto.classId, name: dto.name } });
  }

  listSubjects(classId?: string) {
    return this.db.subject.findMany({
      where: classId ? { classId } : {},
      orderBy: { name: 'asc' },
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────────
  private async mustExist(model: 'campus' | 'class' | 'section', id: string): Promise<void> {
    const row = await (this.db[model] as { findFirst: (a: unknown) => Promise<unknown> }).findFirst({
      where: { id },
    });
    if (!row) {
      throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, `${model} not found`);
    }
  }
}
