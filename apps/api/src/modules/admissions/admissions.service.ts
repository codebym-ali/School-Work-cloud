import { HttpStatus, Injectable } from '@nestjs/common';
import { InquiryStatus } from '@prisma/client';
import {
  AppError,
  assertCampusAccess,
  AuditActions,
  effectiveCampusFilter,
  ErrorCodes,
  normalizePkPhone,
  paginate,
  toSkipTake,
  TenantContext,
  type Paginated,
} from '@common';
import { AuditService, TenantPrismaService } from '@database';
import { AccessService } from '../access/access.service';
import { StudentsService } from '../students/students.service';
import { assertTransition, isOverrideAdmit } from './inquiry-state-machine';
import type {
  AdmitDto,
  CreateInquiryDto,
  InquiryListQuery,
  RecordEntryTestDto,
  ReasonDto,
  ScheduleEntryTestDto,
} from './dto/admissions.dto';

/**
 * Admissions pipeline (blueprint §8): inquiry state machine, entry tests, and the
 * transactional admit. Every mutation runs inside the request transaction, so
 * admit (guardian + student + enrollment + admission + status) is atomic.
 */
@Injectable()
export class AdmissionsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly students: StudentsService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  async createInquiry(dto: CreateInquiryDto) {
    await this.access.assert('admissions.inquiries');
    const phone = normalizePkPhone(dto.guardianPhone);
    if (!phone) throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Invalid guardian phone');
    assertCampusAccess(this.ctx.user, dto.campusId); // a campus-bound user can't create for another campus
    return this.db.inquiry.create({
      data: {
        schoolId: this.sid,
        campusId: dto.campusId,
        guardianName: dto.guardianName,
        guardianPhone: phone,
        studentName: dto.studentName,
        desiredClassId: dto.desiredClassId,
        status: InquiryStatus.INQUIRY,
        createdById: this.ctx.user?.userId,
      },
    });
  }

  async list(q: InquiryListQuery): Promise<Paginated<unknown>> {
    // Campus-bound users are forced to their own campus (client campusId ignored, §22.8).
    const campusId = effectiveCampusFilter(this.ctx.user, q.campusId);
    const where = {
      ...(campusId ? { campusId } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const { skip, take } = toSkipTake(q);
    const [rows, total] = await Promise.all([
      this.db.inquiry.findMany({ where, skip, take, orderBy: { createdAt: 'desc' }, include: { entryTest: true } }),
      this.db.inquiry.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  /**
   * Admissions dashboard rollup for the Admission Portal (§8). Campus-scoped like `list`:
   * a campus-bound controller sees only their own campus's pipeline. Returns pipeline
   * counts by status, tests scheduled today, and admits so far this month.
   */
  async summary() {
    const campusId = effectiveCampusFilter(this.ctx.user, undefined);
    const campusWhere = campusId ? { campusId } : {};

    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [grouped, testsToday, admittedThisMonth, total] = await Promise.all([
      this.db.inquiry.groupBy({ by: ['status'], where: campusWhere, _count: { _all: true } }),
      this.db.entryTest.count({
        where: { scheduledAt: { gte: dayStart, lt: dayEnd }, inquiry: { ...campusWhere, status: InquiryStatus.ENTRY_TEST_SCHEDULED } },
      }),
      this.db.inquiry.count({ where: { ...campusWhere, status: InquiryStatus.ADMITTED, updatedAt: { gte: monthStart } } }),
      this.db.inquiry.count({ where: campusWhere }),
    ]);

    // Every status present, zero-filled, so the funnel always has all stages.
    const byStatus = Object.fromEntries(Object.values(InquiryStatus).map((s) => [s, 0])) as Record<InquiryStatus, number>;
    for (const g of grouped) byStatus[g.status] = g._count._all;

    const admitted = byStatus[InquiryStatus.ADMITTED];
    const conversionRate = total ? Math.round((admitted / total) * 100) : 0;

    return {
      byStatus,
      totals: {
        total,
        open: byStatus[InquiryStatus.INQUIRY],
        testsScheduled: byStatus[InquiryStatus.ENTRY_TEST_SCHEDULED],
        readyToAdmit: byStatus[InquiryStatus.ENTRY_TEST_PASSED],
        admitted,
      },
      testsToday,
      admittedThisMonth,
      conversionRate,
    };
  }

  async getOne(id: string) {
    const inquiry = await this.db.inquiry.findFirst({
      where: { id },
      include: { entryTest: true, admission: true },
    });
    if (!inquiry) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Inquiry not found');
    // Gates every inquiry action (schedule/record/reject/withdraw/admit route through here).
    assertCampusAccess(this.ctx.user, inquiry.campusId);
    return inquiry;
  }

  async scheduleEntryTest(id: string, dto: ScheduleEntryTestDto) {
    await this.access.assert('admissions.inquiries');
    const inquiry = await this.getOne(id);
    assertTransition(inquiry.status, InquiryStatus.ENTRY_TEST_SCHEDULED);
    // find-then-write rather than upsert: the tenant extension merges schoolId into
    // the where clause, which is incompatible with upsert's unique-selector shape.
    const scheduledAt = new Date(dto.scheduledAt);
    const existing = await this.db.entryTest.findFirst({ where: { inquiryId: id } });
    if (existing) {
      await this.db.entryTest.update({ where: { inquiryId: id }, data: { scheduledAt } });
    } else {
      await this.db.entryTest.create({ data: { schoolId: this.sid, inquiryId: id, scheduledAt } });
    }
    return this.changeStatus(id, inquiry.status, InquiryStatus.ENTRY_TEST_SCHEDULED);
  }

  async recordEntryTest(id: string, dto: RecordEntryTestDto) {
    await this.access.assert('admissions.inquiries');
    const inquiry = await this.getOne(id);
    const target = dto.passed ? InquiryStatus.ENTRY_TEST_PASSED : InquiryStatus.ENTRY_TEST_FAILED;
    assertTransition(inquiry.status, target);
    await this.db.entryTest.update({
      where: { inquiryId: id },
      data: { score: dto.score ?? null, remarks: dto.remarks },
    });
    return this.changeStatus(id, inquiry.status, target);
  }

  async reject(id: string, dto: ReasonDto) {
    await this.access.assert('admissions.inquiries');
    const inquiry = await this.getOne(id);
    assertTransition(inquiry.status, InquiryStatus.REJECTED);
    return this.changeStatus(id, inquiry.status, InquiryStatus.REJECTED, dto.reason);
  }

  async withdraw(id: string, dto: ReasonDto) {
    await this.access.assert('admissions.inquiries');
    const inquiry = await this.getOne(id);
    assertTransition(inquiry.status, InquiryStatus.WITHDRAWN);
    return this.changeStatus(id, inquiry.status, InquiryStatus.WITHDRAWN, dto.reason);
  }

  /** Transactional admit (blueprint §8). */
  async admit(dto: AdmitDto) {
    await this.access.assert('admissions.admit');
    const inquiry = await this.getOne(dto.inquiryId);
    assertTransition(inquiry.status, InquiryStatus.ADMITTED);
    const override = isOverrideAdmit(inquiry.status);

    await this.assertAgeEligible(dto.classId, dto.dateOfBirth);

    const created = await this.students.createStudentCore({
      fullName: dto.fullName ?? inquiry.studentName,
      gender: dto.gender,
      dateOfBirth: dto.dateOfBirth,
      classId: dto.classId,
      sectionId: dto.sectionId,
      guardian: dto.guardian,
      grNumber: dto.grNumber,
    });

    await this.db.admission.create({
      data: {
        schoolId: this.sid,
        inquiryId: inquiry.id,
        studentId: created.studentId,
        admittedById: this.ctx.user!.userId,
      },
    });
    await this.db.inquiry.update({ where: { id: inquiry.id }, data: { status: InquiryStatus.ADMITTED } });

    await this.audit.record({
      action: AuditActions.STUDENT_ADMITTED,
      entityType: 'Student',
      entityId: created.studentId,
      newValue: { inquiryId: inquiry.id, grNumber: created.grNumber, overrideAdmit: override },
    });

    // TODO(M4): if an ADMISSION-type fee structure exists for the class, generate
    // the admission invoice in this same transaction (§8.6).
    return { ...created, admissionId: inquiry.id, overrideAdmit: override };
  }

  // ── helpers ──────────────────────────────────────────────────────────────────
  private async changeStatus(id: string, from: InquiryStatus, to: InquiryStatus, reason?: string) {
    if ((to === InquiryStatus.REJECTED || to === InquiryStatus.WITHDRAWN) && !reason) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'reason is required');
    }
    const updated = await this.db.inquiry.update({
      where: { id },
      data: { status: to, statusReason: reason },
    });
    await this.audit.record({
      action: AuditActions.INQUIRY_STATUS_CHANGED,
      entityType: 'Inquiry',
      entityId: id,
      oldValue: { status: from },
      newValue: { status: to },
      reason,
    });
    return updated;
  }

  private async assertAgeEligible(classId: string, dateOfBirth: string): Promise<void> {
    const klass = await this.db.class.findFirst({ where: { id: classId } });
    if (!klass) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Class not found');
    if (klass.minAgeYears == null && klass.maxAgeYears == null) return;
    const age = ageInYears(new Date(dateOfBirth));
    if (klass.minAgeYears != null && age < klass.minAgeYears) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, `Below minimum age for this class (${klass.minAgeYears})`);
    }
    if (klass.maxAgeYears != null && age > klass.maxAgeYears) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, `Above maximum age for this class (${klass.maxAgeYears})`);
    }
  }
}

function ageInYears(dob: Date, at: Date = new Date()): number {
  let age = at.getFullYear() - dob.getFullYear();
  const m = at.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && at.getDate() < dob.getDate())) age--;
  return age;
}
