import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  assertCampusAccess,
  AuditActions,
  ErrorCodes,
  restrictedCampusId,
  TenantContext,
} from '@common';
import { AuditService, TenantPrismaService } from '@database';
import type { CreateCoverDto, CoverQuery } from './dto/cover.dto';

/**
 * Cover — who is taking a class when the teacher who normally does is away (Cover Plan, C0).
 *
 * **The gap this closes is one sentence:** a substitute standing in the room could not mark the
 * register. `assertCanMark` requires a `TeacherAssignment`, so they got *"You are not assigned to
 * this section"*, and only an admin could close it — someone had to walk to the office.
 *
 * **It works with nothing else filled in.** Three fields: section, date, who is covering. No
 * timetable, no staff attendance. Both of those make it *faster* later (C1, C3), but neither is a
 * prerequisite — `timetable_slots` has zero rows in every school today, and a feature that needs
 * two registers a school may not keep is a feature that looks broken on day one.
 *
 * ⚠️ **Creating cover is a permission grant, not a note.** It gives one person write access to
 * another class's register — data that feeds pay and defaulter reporting — and it can be
 * backdated. Hence: audited both ways, campus-scoped, and refused into a month whose payroll is
 * already APPROVED.
 */
@Injectable()
export class CoverService {
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

  private static readonly INCLUDE = {
    section: { select: { id: true, name: true, class: { select: { id: true, name: true, campusId: true } } } },
    coveringStaff: { select: { id: true, fullName: true, employeeCode: true } },
    absentStaff: { select: { id: true, fullName: true, employeeCode: true } },
  } satisfies Prisma.CoverAssignmentInclude;

  /** Cover on a day. Campus-scoped for a campus admin, like every other oversight read. */
  async list(q: CoverQuery) {
    const date = new Date(q.date ?? new Date().toISOString().slice(0, 10));
    const restricted = restrictedCampusId(this.ctx.user);
    const rows = await this.db.coverAssignment.findMany({
      where: { date, ...(restricted ? { section: { class: { campusId: restricted } } } : {}) },
      include: CoverService.INCLUDE,
      orderBy: [{ periodNo: 'asc' }, { createdAt: 'asc' }],
    });
    return { date: date.toISOString().slice(0, 10), cover: rows };
  }

  async create(dto: CreateCoverDto) {
    const date = new Date(dto.date);

    const section = await this.db.section.findFirst({
      where: { id: dto.sectionId },
      select: { id: true, name: true, class: { select: { name: true, campusId: true } } },
    });
    if (!section) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Section not found');
    assertCampusAccess(this.ctx.user, section.class.campusId);

    const covering = await this.db.staffProfile.findFirst({
      where: { id: dto.coveringStaffId },
      select: { id: true, fullName: true, employeeCode: true, leftAt: true },
    });
    if (!covering) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Staff member not found');
    const coveringName = covering.fullName ?? covering.employeeCode;
    if (covering.leftAt && covering.leftAt <= date) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY,
        `${coveringName} had left the school by that date`);
    }

    await this.assertPayrollOpen(date, section.class.campusId);

    // Find-then-write, not `upsert`: the tenant extension merges `schoolId` into the where clause
    // and breaks a compound unique selector — a documented trap in this codebase.
    const clash = await this.db.coverAssignment.findFirst({
      where: { sectionId: dto.sectionId, date, periodNo: dto.periodNo ?? null },
      include: { coveringStaff: { select: { fullName: true, employeeCode: true } } },
    });
    if (clash) {
      const who = clash.coveringStaff.fullName ?? clash.coveringStaff.employeeCode;
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT,
        `${who} is already covering ${section.class.name}-${section.name}${dto.periodNo ? ` period ${dto.periodNo}` : ' that day'}`);
    }

    const created = await this.db.coverAssignment.create({
      data: {
        schoolId: this.sid,
        date,
        sectionId: dto.sectionId,
        periodNo: dto.periodNo ?? null,
        coveringStaffId: dto.coveringStaffId,
        absentStaffId: dto.absentStaffId ?? null,
        reason: dto.reason ?? null,
        arrangedById: this.ctx.user!.userId,
      },
      include: CoverService.INCLUDE,
    });

    // The audit row has to outlive the cover, so it carries names rather than only ids — audit_logs
    // has no FK to the entity, by design.
    await this.audit.record({
      action: AuditActions.COVER_ASSIGNED,
      entityType: 'CoverAssignment',
      entityId: created.id,
      newValue: {
        date: dto.date,
        section: `${section.class.name}-${section.name}`,
        periodNo: dto.periodNo ?? null,
        covering: coveringName,
        absent: created.absentStaff ? (created.absentStaff.fullName ?? created.absentStaff.employeeCode) : null,
        reason: dto.reason ?? null,
      },
    });
    return created;
  }

  async remove(id: string) {
    const row = await this.db.coverAssignment.findFirst({ where: { id }, include: CoverService.INCLUDE });
    if (!row) return { deleted: false };
    assertCampusAccess(this.ctx.user, row.section.class.campusId);
    await this.assertPayrollOpen(row.date, row.section.class.campusId);

    await this.db.coverAssignment.delete({ where: { id } });
    await this.audit.record({
      action: AuditActions.COVER_REMOVED,
      entityType: 'CoverAssignment',
      entityId: id,
      // Removing cover REMOVES someone's access to a register, so what it was matters as much as
      // that it happened.
      oldValue: {
        date: row.date.toISOString().slice(0, 10),
        section: `${row.section.class.name}-${row.section.name}`,
        periodNo: row.periodNo,
        covering: row.coveringStaff.fullName ?? row.coveringStaff.employeeCode,
      },
    });
    return { deleted: true };
  }

  /**
   * Is this staff member covering this section on this date?
   *
   * The whole point of C0 — called from `assertCanMark`. Deliberately narrow: **that section, that
   * date**. Period is not considered, because attendance is marked per day and per session, not
   * per period; a cover for period 3 still means that person was with the class that day.
   */
  async coversSectionOn(staffId: string, sectionId: string, date: Date): Promise<boolean> {
    const found = await this.db.coverAssignment.findFirst({
      where: { coveringStaffId: staffId, sectionId, date },
      select: { id: true },
    });
    return Boolean(found);
  }

  /**
   * A payslip computed from a register must not start disagreeing with it.
   *
   * Cover grants the right to *change* attendance, so granting it into a settled month is the same
   * hole as editing the register directly — the freeze is per campus, matching `PayrollRun`'s
   * unique key, so one campus closing its month does not stop another arranging cover.
   */
  private async assertPayrollOpen(date: Date, campusId: string): Promise<void> {
    const frozen = await this.db.payrollRun.findFirst({
      where: { campusId, month: date.getUTCMonth() + 1, year: date.getUTCFullYear(), status: 'APPROVED' },
      select: { id: true },
    });
    if (frozen) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT,
        'Payroll for that month is already approved — cover cannot be changed for a settled month');
    }
  }
}
