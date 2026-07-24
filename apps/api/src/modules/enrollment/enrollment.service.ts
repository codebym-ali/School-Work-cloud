import { HttpStatus, Injectable } from '@nestjs/common';
import { EnrollmentStatus } from '@prisma/client';
import {
  AppError,
  AuditActions,
  ErrorCodes,
  paginate,
  TenantContext,
  toSkipTake,
  type Paginated,
} from '@common';
import { AuditService, TenantPrismaService } from '@database';
import type { EnrollmentListQuery, TransferDto } from './dto/enrollment.dto';

/**
 * Enrollment reads + section/campus transfer (blueprint §7). A transfer is never a
 * destructive field update: the old ACTIVE enrollment is closed (TRANSFERRED_OUT +
 * endedAt) and a NEW ACTIVE enrollment is created — moves are new rows. Runs in the
 * request transaction so the "one ACTIVE per (student, year)" invariant holds.
 */
@Injectable()
export class EnrollmentService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly ctx: TenantContext,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  async list(q: EnrollmentListQuery): Promise<Paginated<unknown>> {
    const where = {
      // Never surface soft-deleted students in operational lists (e.g. the attendance roster,
      // which loads ?status=ACTIVE) — otherwise a removed student stays markable/billable.
      student: { deletedAt: null },
      ...(q.academicYearId ? { academicYearId: q.academicYearId } : {}),
      ...(q.sectionId ? { sectionId: q.sectionId } : {}),
      ...(q.studentId ? { studentId: q.studentId } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const { skip, take } = toSkipTake(q);
    const [rows, total] = await Promise.all([
      this.db.studentEnrollment.findMany({
        where,
        skip,
        take,
        orderBy: { startedAt: 'desc' },
        include: { student: { select: { id: true, fullName: true, grNumber: true } } },
      }),
      this.db.studentEnrollment.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  async transfer(dto: TransferDto) {
    const current = await this.db.studentEnrollment.findFirst({
      where: { studentId: dto.studentId, status: EnrollmentStatus.ACTIVE },
    });
    if (!current) {
      throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'No active enrollment for student');
    }

    const section = await this.db.section.findFirst({
      where: { id: dto.toSectionId },
      include: { class: { select: { id: true, campusId: true } } },
    });
    if (!section) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Target section not found');
    if (section.id === current.sectionId) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Student is already in that section');
    }

    // Close the old enrollment first (partial-unique: one ACTIVE per student+year).
    await this.db.studentEnrollment.update({
      where: { id: current.id },
      data: { status: EnrollmentStatus.TRANSFERRED_OUT, endedAt: new Date() },
    });
    const created = await this.db.studentEnrollment.create({
      data: {
        schoolId: this.ctx.requireSchoolId(),
        studentId: dto.studentId,
        academicYearId: current.academicYearId,
        campusId: section.class.campusId,
        classId: section.class.id,
        sectionId: section.id,
        status: EnrollmentStatus.ACTIVE,
      },
    });

    await this.audit.record({
      action: AuditActions.ENROLLMENT_TRANSFERRED,
      entityType: 'StudentEnrollment',
      entityId: created.id,
      oldValue: { enrollmentId: current.id, sectionId: current.sectionId },
      newValue: { enrollmentId: created.id, sectionId: created.sectionId },
    });
    return created;
  }
}
