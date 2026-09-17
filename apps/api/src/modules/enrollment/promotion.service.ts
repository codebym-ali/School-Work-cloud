import { HttpStatus, Injectable } from '@nestjs/common';
import { EnrollmentStatus, FeeInvoiceStatus, Prisma } from '@prisma/client';
import {
  AppError, assertCampusAccess, assertOwnerOverride, AuditActions, effectiveCampusFilter, ErrorCodes, parseSchoolSettings, TenantContext,
} from '@common';
import { AuditService, TenantPrismaService } from '@database';
import type { PromoteDto, PromotionCommitDto, PromotionPlanDto } from './dto/promotion.dto';
import { planFingerprint, planPromotion, type PlanLine } from './promotion-planner';

export interface PromotionResult {
  promoted: number;
  retained: number;
  withdrawn: number;
  completed: number;
  skipped: number;
  blocked: Array<{ studentId: string; studentName: string; reason: string }>;
  /** Kept for callers of the original response shape. Mirrors `blocked`. */
  errors: Array<{ studentId: string; code: string; message: string }>;
}

export interface PromotionPreview {
  targetYear: { id: string; name: string };
  fingerprint: string;
  requireFeeClearance: boolean;
  sections: Array<{
    sectionId: string;
    label: string;
    campus: string;
    lines: Array<PlanLine & { toLabel: string | null }>;
  }>;
  totals: { promoted: number; retained: number; withdrawn: number; completed: number; skipped: number; blocked: number };
}

const OWING = [FeeInvoiceStatus.PENDING, FeeInvoiceStatus.PARTIAL, FeeInvoiceStatus.OVERDUE];

/**
 * Year-end promotion (blueprint §7, GAP-03): preview → exceptions → commit.
 *
 * Every placement rule lives in `promotion-planner.ts` and is unit-tested there. This service loads the
 * planner's inputs and writes its result.
 *
 * ⚠️ **B1 — a fixed number of queries, whatever the size of the school.** The previous loop ran about four
 * queries per student (an existence check, a fee check, an update, a create): roughly 6,000 round trips to
 * promote 1,500 students, in the one week a timeout matters most. Inputs now load in nine queries, fee and
 * "already placed" checks become hash-set lookups, and writes are one `updateMany` per outcome plus one
 * `createMany`.
 *
 * ⚠️ **B5/F4 — nothing is written blind.** `preview()` returns exactly what `commit()` will do plus a
 * fingerprint of those decisions. `commit()` recomputes the plan and refuses with 409 if the fingerprint
 * differs — a student admitted, moved, or who paid their fees since the owner reviewed the list.
 *
 * ⚠️ **B7 — a whole campus in one request, atomically.** The request transaction covers every write, so a
 * failure leaves nothing half-promoted, and a re-run skips students already placed. Seats are counted across
 * sections: 1-A and 1-B both fill Grade 2, which per-section calls could not see.
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

  async preview(dto: PromotionPlanDto): Promise<PromotionPreview> {
    const built = await this.build(dto);
    const label = (sectionId: string | null) => {
      if (!sectionId) return null;
      const s = built.sectionById.get(sectionId);
      return s ? `${built.classById.get(s.classId)?.name ?? ''} ${s.name}`.trim() : null;
    };
    const sections = built.sourceSections.map((s) => ({
      sectionId: s.id,
      label: `${built.classById.get(s.classId)?.name ?? ''} ${s.name}`.trim(),
      campus: built.campusName.get(built.classById.get(s.classId)?.campusId ?? '') ?? '',
      lines: built.lines.filter((l) => l.fromSectionId === s.id).map((l) => ({ ...l, toLabel: label(l.toSectionId) })),
    }));
    return {
      targetYear: { id: built.targetYear.id, name: built.targetYear.name },
      fingerprint: planFingerprint(built.lines),
      requireFeeClearance: built.requireFeeClearance,
      sections,
      totals: tally(built.lines),
    };
  }

  async commit(dto: PromotionCommitDto): Promise<PromotionResult> {
    const built = await this.build(dto);
    if (planFingerprint(built.lines) !== dto.fingerprint) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        HttpStatus.CONFLICT,
        'Something changed since you reviewed this list — a student was admitted, moved, or paid. Review it again before promoting.',
      );
    }
    return this.apply(built, dto);
  }

  /**
   * The original single-section route, kept so existing callers keep working. It plans and applies in one
   * step with no preview; the screen uses `preview` + `commit`.
   */
  async promote(dto: PromoteDto): Promise<PromotionResult> {
    const built = await this.build({ ...dto, sectionIds: [dto.sectionId] });
    return this.apply(built, dto);
  }

  // ── internals ────────────────────────────────────────────────────────────────
  private async build(dto: PromotionPlanDto) {
    // ⚠️ Before anything is read: an override bypasses a financial control, and "owner-only" was once
    // enforced for nobody (see assertOwnerOverride).
    assertOwnerOverride(this.ctx.user, dto.overridePreconditions, 'promotion preconditions');

    // Scope: named sections, else a campus. A campus-bound caller is forced to their own campus either way.
    let campusIds: string[];
    if (dto.sectionIds?.length) {
      const named = await this.db.section.findMany({ where: { id: { in: dto.sectionIds } }, select: { id: true, class: { select: { campusId: true } } } });
      if (named.length !== new Set(dto.sectionIds).size) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Section not found');
      // ⚠️ By id alone RLS scopes to the school, not the campus — check every named section's campus.
      for (const s of named) assertCampusAccess(this.ctx.user, s.class.campusId);
      campusIds = [...new Set(named.map((s) => s.class.campusId))];
    } else {
      const forced = effectiveCampusFilter(this.ctx.user, dto.campusId);
      if (!forced) throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.BAD_REQUEST, 'Choose a campus to promote');
      campusIds = [forced];
    }

    // After the campus check, deliberately: a caller refused a campus learns nothing about other years.
    const targetYear = await this.db.academicYear.findFirst({ where: { id: dto.targetYearId }, select: { id: true, name: true, startDate: true } });
    if (!targetYear) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Target year not found');

    const [school, campuses, classes, sections] = await Promise.all([
      this.db.school.findFirst({ where: { id: this.sid }, select: { settings: true } }),
      this.db.campus.findMany({ where: { id: { in: campusIds } }, select: { id: true, name: true } }),
      this.db.class.findMany({ where: { campusId: { in: campusIds } }, select: { id: true, campusId: true, order: true, name: true } }),
      this.db.section.findMany({ where: { class: { campusId: { in: campusIds } } }, select: { id: true, classId: true, name: true, capacity: true } }),
    ]);
    const settings = parseSchoolSettings(school?.settings ?? {});
    const requireFeeClearance = settings.promotionRequiresFeeClearance && !dto.overridePreconditions;

    const sourceIds = dto.sectionIds?.length ? new Set(dto.sectionIds) : new Set(sections.map((s) => s.id));
    // ⚠️ Excluding the TARGET year matters: a retained student's new enrolment is ACTIVE in the same section.
    // Without this, running promotion a second time would move them again.
    const enrollments = await this.db.studentEnrollment.findMany({
      where: { sectionId: { in: [...sourceIds] }, status: EnrollmentStatus.ACTIVE, academicYearId: { not: targetYear.id }, student: { deletedAt: null } },
      select: { id: true, studentId: true, campusId: true, classId: true, sectionId: true, student: { select: { fullName: true } } },
    });
    const studentIds = enrollments.map((e) => e.studentId);

    const [placed, seated, invoices] = await Promise.all([
      this.db.studentEnrollment.findMany({ where: { studentId: { in: studentIds }, academicYearId: targetYear.id, status: EnrollmentStatus.ACTIVE }, select: { studentId: true } }),
      this.db.studentEnrollment.groupBy({ by: ['sectionId'], where: { academicYearId: targetYear.id, status: EnrollmentStatus.ACTIVE, sectionId: { in: sections.map((s) => s.id) } }, _count: { _all: true } }),
      requireFeeClearance
        ? this.db.feeInvoice.findMany({ where: { studentId: { in: studentIds }, status: { in: OWING } }, select: { studentId: true, month: true, year: true } })
        : Promise.resolve([] as Array<{ studentId: string; month: number | null; year: number }>),
    ]);

    // B6: owed only for a billing period that has BEGUN. An invoice raised early for next month is not a debt.
    const now = new Date();
    const owing = new Set(invoices.filter((i) => new Date(Date.UTC(i.year, (i.month ?? 1) - 1, 1)) <= now).map((i) => i.studentId));

    const overrides = new Map<string, 'RETAIN' | 'WITHDRAW'>(
      (dto.overrides ?? []).map((o) => [o.studentId, o.action === 'WITHDRAWN' ? 'WITHDRAW' : 'RETAIN']),
    );

    const lines = planPromotion({
      enrollments: enrollments.map((e) => ({ id: e.id, studentId: e.studentId, studentName: e.student.fullName, campusId: e.campusId, classId: e.classId, sectionId: e.sectionId })),
      classes,
      sections,
      seatedInTargetYear: new Map(seated.map((g) => [g.sectionId, g._count._all])),
      alreadyPlaced: new Set(placed.map((p) => p.studentId)),
      owing,
      overrides,
      requireFeeClearance,
      hardCapacity: settings.sectionCapacityMode === 'HARD',
    });

    const classById = new Map(classes.map((c) => [c.id, c]));
    return {
      targetYear,
      lines,
      requireFeeClearance,
      classById,
      sectionById: new Map(sections.map((s) => [s.id, s])),
      campusName: new Map(campuses.map((c) => [c.id, c.name])),
      sourceSections: sections
        .filter((s) => sourceIds.has(s.id))
        .sort((a, b) => (classById.get(a.classId)?.order ?? 0) - (classById.get(b.classId)?.order ?? 0) || a.name.localeCompare(b.name)),
    };
  }

  private async apply(built: Awaited<ReturnType<PromotionService['build']>>, dto: PromotionPlanDto & { reason?: string }): Promise<PromotionResult> {
    const { lines, targetYear, sectionById, classById } = built;
    const endedAt = new Date();
    const idsFor = (o: string) => lines.filter((l) => l.outcome === o).map((l) => l.enrollmentId);

    // Close first, then open: the partial unique index allows one ACTIVE enrolment per student PER YEAR, so
    // the order is not required by it — but closing first means a failure can never leave two ACTIVE rows.
    const outcomes: Array<[string, EnrollmentStatus]> = [
      ['PROMOTED', EnrollmentStatus.PROMOTED], ['RETAINED', EnrollmentStatus.RETAINED],
      ['WITHDRAWN', EnrollmentStatus.WITHDRAWN], ['COMPLETED', EnrollmentStatus.COMPLETED],
    ];
    for (const [o, status] of outcomes) {
      const ids = idsFor(o);
      if (ids.length) await this.db.studentEnrollment.updateMany({ where: { id: { in: ids } }, data: { status, endedAt } });
    }

    const moves = lines.filter((l) => (l.outcome === 'PROMOTED' || l.outcome === 'RETAINED') && l.toSectionId);
    if (moves.length) {
      try {
        await this.db.studentEnrollment.createMany({
          data: moves.map((l) => {
            const section = sectionById.get(l.toSectionId!)!;
            return {
              schoolId: this.sid, studentId: l.studentId, academicYearId: targetYear.id, status: EnrollmentStatus.ACTIVE,
              campusId: classById.get(section.classId)!.campusId, classId: section.classId, sectionId: section.id,
              startedAt: targetYear.startDate,
            };
          }),
        });
      } catch (e) {
        // Two commits racing: both saw these students unplaced, and the one-ACTIVE-per-year index refused the
        // second. The request rolls back, so nothing was half-applied.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'This promotion was already committed by someone else. Reload to see it.');
        }
        throw e;
      }
    }

    // Students who leave the roster — completed school, or not returning — are no longer active students.
    const leaving = lines.filter((l) => l.outcome === 'COMPLETED' || l.outcome === 'WITHDRAWN').map((l) => l.studentId);
    if (leaving.length) await this.db.student.updateMany({ where: { id: { in: leaving } }, data: { isActive: false } });

    const t = tally(lines);
    const blocked = lines.filter((l) => l.blocked).map((l) => ({ studentId: l.studentId, studentName: l.studentName, reason: l.blocked! }));
    await this.audit.record({
      action: dto.overridePreconditions ? AuditActions.PROMOTION_OVERRIDE : AuditActions.PROMOTION_COMMITTED,
      entityType: 'AcademicYear',
      entityId: targetYear.id,
      ...(dto.reason ? { reason: dto.reason } : {}),
      newValue: { ...t, sections: built.sourceSections.map((s) => s.id), overrodeFeeClearance: !!dto.overridePreconditions },
    });

    return {
      promoted: t.promoted, retained: t.retained, withdrawn: t.withdrawn, completed: t.completed, skipped: t.skipped,
      blocked,
      errors: blocked.map((b) => ({ studentId: b.studentId, code: ErrorCodes.VALIDATION_FAILED, message: b.reason })),
    };
  }
}

function tally(lines: PlanLine[]) {
  const count = (o: string) => lines.filter((l) => l.outcome === o).length;
  return {
    promoted: count('PROMOTED'), retained: count('RETAINED'), withdrawn: count('WITHDRAWN'), completed: count('COMPLETED'),
    skipped: lines.filter((l) => l.skipped).length, blocked: lines.filter((l) => l.blocked).length,
  };
}
