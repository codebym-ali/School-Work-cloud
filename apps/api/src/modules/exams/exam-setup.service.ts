import { HttpStatus, Injectable } from '@nestjs/common';
import { AppError, AuditActions, ErrorCodes, TenantContext } from '@common';
import { AuditService, TenantPrismaService } from '@database';
import type { CreateTermDto, SetGradeScaleDto } from './dto/exams.dto';

/** Grade scales + terms (blueprint §11). Exactly one scale (set of bands) per year. */
@Injectable()
export class ExamSetupService {
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

  /**
   * Delete a term that was created by mistake. Refuses once the term carries academic
   * records — exams or report cards reference it, and silently cascading would destroy
   * published results. The caller is told exactly what is holding it.
   */
  async deleteTerm(id: string) {
    const term = await this.db.term.findFirst({ where: { id } });
    if (!term) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Term not found');

    const [exams, reportCards] = await Promise.all([
      this.db.examDefinition.count({ where: { termId: id } }),
      this.db.reportCard.count({ where: { termId: id } }),
    ]);
    if (exams > 0 || reportCards > 0) {
      const blockers = [
        exams > 0 ? `${exams} exam${exams === 1 ? '' : 's'}` : null,
        reportCards > 0 ? `${reportCards} report card${reportCards === 1 ? '' : 's'}` : null,
      ].filter(Boolean).join(' and ');
      throw new AppError(
        ErrorCodes.CONFLICT,
        HttpStatus.CONFLICT,
        `"${term.name}" still has ${blockers} — it cannot be deleted`,
      );
    }

    await this.db.term.delete({ where: { id } });
    await this.audit.record({
      action: AuditActions.TERM_DELETED,
      entityType: 'Term',
      entityId: id,
      oldValue: { name: term.name, academicYearId: term.academicYearId },
    });
    return { ok: true };
  }
}
