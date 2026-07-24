import { HttpStatus, Injectable } from '@nestjs/common';
import { AppError, ErrorCodes, TenantContext } from '@common';
import { TenantPrismaService } from '@database';

/**
 * Teacher self-service (blueprint §9/§11 — the teacher's launch point). Read-only and
 * self-scoped: the caller's `StaffProfile` is resolved from their user, and only the
 * sections they hold a `TeacherAssignment` for are visible. A roster request for a section
 * the teacher isn't assigned to is 403'd (ownership, §22.8) — the same rule the attendance
 * and marks-entry services already enforce for writes.
 */
@Injectable()
export class TeachingService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  /** The StaffProfile for the logged-in user, or 403 if the account has none. */
  private async self() {
    const userId = this.ctx.user?.userId;
    const staff = userId ? await this.db.staffProfile.findFirst({ where: { userId } }) : null;
    if (!staff) throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'No staff profile is linked to this account');
    return staff;
  }

  /** The teacher's assigned classes/sections/subjects, with a live active-student count. */
  async myClasses() {
    const staff = await this.self();
    const assignments = await this.db.teacherAssignment.findMany({
      where: { staffId: staff.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!assignments.length) return [];

    // Batch-resolve the display names (TeacherAssignment carries ids only).
    const [sections, subjects, years, counts] = await Promise.all([
      this.db.section.findMany({
        where: { id: { in: unique(assignments.map((a) => a.sectionId)) } },
        include: { class: { select: { id: true, name: true } } },
      }),
      this.db.subject.findMany({
        where: { id: { in: unique(assignments.map((a) => a.subjectId).filter((x): x is string => !!x)) } },
        select: { id: true, name: true },
      }),
      this.db.academicYear.findMany({
        where: { id: { in: unique(assignments.map((a) => a.academicYearId)) } },
        select: { id: true, name: true },
      }),
      this.db.studentEnrollment.groupBy({
        by: ['sectionId'],
        // Exclude soft-deleted students so the header count matches the roster (which filters them).
        where: { sectionId: { in: unique(assignments.map((a) => a.sectionId)) }, status: 'ACTIVE', student: { deletedAt: null } },
        _count: { _all: true },
      }),
    ]);

    const sectionById = new Map(sections.map((s) => [s.id, s]));
    const subjectName = new Map(subjects.map((s) => [s.id, s.name]));
    const yearName = new Map(years.map((y) => [y.id, y.name]));
    const countBySection = new Map(counts.map((c) => [c.sectionId, c._count._all]));

    return assignments.map((a) => {
      const section = sectionById.get(a.sectionId);
      return {
        assignmentId: a.id,
        sectionId: a.sectionId,
        sectionName: section?.name ?? '—',
        classId: section?.class.id ?? null,
        className: section?.class.name ?? '—',
        academicYearId: a.academicYearId,
        yearName: yearName.get(a.academicYearId) ?? '—',
        subjectId: a.subjectId,
        subjectName: a.subjectId ? subjectName.get(a.subjectId) ?? '—' : null,
        isClassTeacher: a.subjectId === null,
        studentCount: countBySection.get(a.sectionId) ?? 0,
      };
    });
  }

  /** The active roster of a section the teacher is assigned to (else 403). */
  async roster(sectionId: string) {
    const staff = await this.self();
    const assigned = await this.db.teacherAssignment.findFirst({ where: { staffId: staff.id, sectionId } });
    if (!assigned) throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Not assigned to this section');

    const enrollments = await this.db.studentEnrollment.findMany({
      where: { sectionId, status: 'ACTIVE', student: { deletedAt: null } },
      include: { student: { select: { id: true, fullName: true, grNumber: true, registrationNo: true } } },
      orderBy: [{ rollNumber: 'asc' }],
    });
    return enrollments.map((e) => ({
      studentId: e.student.id,
      fullName: e.student.fullName,
      grNumber: e.student.grNumber,
      registrationNo: e.student.registrationNo,
      rollNumber: e.rollNumber,
      enrollmentId: e.id,
    }));
  }
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
