import { HttpStatus, Injectable } from '@nestjs/common';
import { EnrollmentStatus } from '@prisma/client';
import {
  AppError,
  assertCampusAccess,
  AuditActions,
  ErrorCodes,
  paginate,
  restrictedCampusId,
  TenantContext,
  toSkipTake,
  type Paginated,
} from '@common';
import { AuditService, TenantPrismaService } from '@database';
import { SetupService } from '../setup/setup.service';
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
    private readonly setup: SetupService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  async list(q: EnrollmentListQuery): Promise<Paginated<unknown>> {
    // Campus scoping (§22.8): `StudentEnrollment` carries `campusId` — written on admission and
    // re-written on transfer — so a campus-bound reader sees their own campus and no other. It was
    // unscoped, which meant a campus admin could read every campus's roster.
    const restricted = restrictedCampusId(this.ctx.user);
    const where = {
      ...(restricted ? { campusId: restricted } : {}),
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

    // ⚠️ **Both ends, §22.8.** A campus-bound admin may move a child *within* their campus and
    // nowhere else — checking only the destination would let them push a student out of their
    // campus, and checking only the source would let them pull one in. This write relocates a child
    // between campuses, so it is the one place where checking a single end is obviously not enough.
    assertCampusAccess(this.ctx.user, current.campusId);

    const section = await this.db.section.findFirst({
      where: { id: dto.toSectionId },
      include: { class: { select: { id: true, campusId: true } } },
    });
    if (!section) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Target section not found');
    assertCampusAccess(this.ctx.user, section.class.campusId);
    if (section.id === current.sectionId) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Student is already in that section');
    }

    // The same rule admission uses, from the same method — a 41st child must not be *moved* into a
    // section a new admission would have been refused from. Honours `sectionCapacityMode`, so an
    // ADVISORY school is still allowed through and warned by the UI.
    await this.setup.assertSectionHasRoom(section.id, current.academicYearId, section.capacity);

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
