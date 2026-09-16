import { HttpStatus, Injectable } from '@nestjs/common';
import { EnrollmentStatus, FeeInvoiceStatus } from '@prisma/client';
import { AppError, assertCampusAccess, assertOwnerOverride, AuditActions, ErrorCodes, parseSchoolSettings, TenantContext } from '@common';
import { AuditService, TenantPrismaService } from '@database';
import type { PromoteDto } from './dto/promotion.dto';

export interface PromotionResult {
  promoted: number;
  retained: number;
  withdrawn: number;
  skipped: number;
  errors: Array<{ studentId: string; code: string; message: string }>;
}

/**
 * Year-end promotion (blueprint §7). Per student in the source section: close the old
 * ACTIVE enrollment (PROMOTED/RETAINED/WITHDRAWN) and open a new ACTIVE enrollment in
 * the target year (moves are new rows). Preconditions (fee clearance; report card) are
 * server-enforced and OWNER_ADMIN-overridable. Idempotent: a student who already has an
 * ACTIVE enrollment in the target year is skipped.
 */
@Injectable()
export class PromotionService {
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

  async promote(dto: PromoteDto): Promise<PromotionResult> {
    // ⚠️ Checked before anything is read or written: an override is a bypass of a financial control,
    // and "documented owner-only" was enforced for nobody. See assertOwnerOverride.
    assertOwnerOverride(this.ctx.user, dto.overridePreconditions, 'promotion preconditions');

    const section = await this.db.section.findFirst({ where: { id: dto.sectionId }, include: { class: true } });
    if (!section) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Section not found');
    // ⚠️ The section was found by id alone, which RLS scopes to the SCHOOL but not the campus. A
    // campus admin could otherwise promote — and close the enrolments of — another campus's class.
    assertCampusAccess(this.ctx.user, section.class.campusId);
    const targetYear = await this.db.academicYear.findFirst({ where: { id: dto.targetYearId } });
    if (!targetYear) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Target year not found');

    const settings = parseSchoolSettings((await this.db.school.findFirst({ where: { id: this.sid } }))?.settings ?? {});
    const requireClearance = settings.promotionRequiresFeeClearance && !dto.overridePreconditions;

    // Resolve the promotion target class (next by order in the same campus) + a section.
    const nextClass = await this.db.class.findFirst({ where: { campusId: section.class.campusId, order: section.class.order + 1 } });
    const nextSection = nextClass
      ? (await this.db.section.findFirst({ where: { classId: nextClass.id, name: section.name } })) ??
        (await this.db.section.findFirst({ where: { classId: nextClass.id } }))
      : null;

    const overrides = new Map((dto.overrides ?? []).map((o) => [o.studentId, o.action]));
    const enrollments = await this.db.studentEnrollment.findMany({
      where: { sectionId: dto.sectionId, status: EnrollmentStatus.ACTIVE },
    });

    const result: PromotionResult = { promoted: 0, retained: 0, withdrawn: 0, skipped: 0, errors: [] };
    for (const enr of enrollments) {
      // Idempotent: already placed in the target year.
      const already = await this.db.studentEnrollment.findFirst({ where: { studentId: enr.studentId, academicYearId: dto.targetYearId, status: EnrollmentStatus.ACTIVE } });
      if (already) { result.skipped++; continue; }

      const action = overrides.get(enr.studentId) ?? 'PROMOTED';

      if (action !== 'WITHDRAWN' && requireClearance && !(await this.feeCleared(enr.studentId))) {
        result.errors.push({ studentId: enr.studentId, code: ErrorCodes.VALIDATION_FAILED, message: 'Fee not cleared (override required)' });
        continue;
      }
      if (action === 'PROMOTED' && (!nextClass || !nextSection)) {
        result.errors.push({ studentId: enr.studentId, code: ErrorCodes.VALIDATION_FAILED, message: 'No next class/section to promote into' });
        continue;
      }

      const closeStatus = action === 'WITHDRAWN' ? EnrollmentStatus.WITHDRAWN : action === 'RETAINED' ? EnrollmentStatus.RETAINED : EnrollmentStatus.PROMOTED;
      await this.db.studentEnrollment.update({ where: { id: enr.id }, data: { status: closeStatus, endedAt: new Date() } });

      if (action !== 'WITHDRAWN') {
        const target = action === 'RETAINED'
          ? { campusId: enr.campusId, classId: enr.classId, sectionId: enr.sectionId }
          : { campusId: nextClass!.campusId, classId: nextClass!.id, sectionId: nextSection!.id };
        await this.db.studentEnrollment.create({
          data: { schoolId: this.sid, studentId: enr.studentId, academicYearId: dto.targetYearId, status: EnrollmentStatus.ACTIVE, ...target },
        });
      }

      if (action === 'PROMOTED') result.promoted++;
      else if (action === 'RETAINED') result.retained++;
      else result.withdrawn++;
    }

    if (dto.overridePreconditions) {
      await this.audit.record({
        action: AuditActions.PROMOTION_OVERRIDE,
        entityType: 'Section',
        entityId: dto.sectionId,
        reason: dto.reason,
        newValue: { targetYearId: dto.targetYearId, ...result },
      });
    }
    return result;
  }

  private async feeCleared(studentId: string): Promise<boolean> {
    const unpaid = await this.db.feeInvoice.findFirst({
      where: { studentId, status: { in: [FeeInvoiceStatus.PENDING, FeeInvoiceStatus.PARTIAL, FeeInvoiceStatus.OVERDUE] } },
    });
    return !unpaid;
  }
}
