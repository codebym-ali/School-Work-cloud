import { HttpStatus, Injectable } from '@nestjs/common';
import { AppError, ErrorCodes, TenantContext } from '@common';
import { TenantPrismaService } from '@database';
import type { CreateTermDto, SetGradeScaleDto } from './dto/exams.dto';

/** Grade scales + terms (blueprint §11). Exactly one scale (set of bands) per year. */
@Injectable()
export class ExamSetupService {
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

  /** Replace the year's grade scale with the given bands (validated non-overlapping-ish). */
  async setGradeScale(dto: SetGradeScaleDto) {
    for (const b of dto.bands) {
      if (b.maxPercent < b.minPercent) {
        throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, `Band ${b.label}: maxPercent < minPercent`);
      }
    }
    await this.db.gradeScale.deleteMany({ where: { academicYearId: dto.academicYearId } });
    await this.db.gradeScale.createMany({
      data: dto.bands.map((b) => ({
        schoolId: this.sid,
        academicYearId: dto.academicYearId,
        label: b.label,
        minPercent: b.minPercent,
        maxPercent: b.maxPercent,
        gradePoint: b.gradePoint,
      })),
    });
    return this.getGradeScale(dto.academicYearId);
  }

  getGradeScale(academicYearId: string) {
    return this.db.gradeScale.findMany({ where: { academicYearId }, orderBy: { minPercent: 'desc' } });
  }

  // ── Terms ────────────────────────────────────────────────────────────────────
  createTerm(dto: CreateTermDto) {
    return this.db.term.create({
      data: {
        schoolId: this.sid,
        academicYearId: dto.academicYearId,
        name: dto.name,
        startDate: new Date(dto.startDate),
        endDate: new Date(dto.endDate),
      },
    });
  }

  listTerms(academicYearId?: string) {
    return this.db.term.findMany({
      where: academicYearId ? { academicYearId } : {},
      orderBy: { startDate: 'asc' },
    });
  }
}
