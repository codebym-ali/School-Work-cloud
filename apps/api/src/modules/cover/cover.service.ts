import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  assertCampusAccess,
  AuditActions,
  ErrorCodes,
  parseSchoolSettings,
  restrictedCampusId,
  TenantContext,
  workingDaysBetween,
} from '@common';
import { AuditService, TenantPrismaService } from '@database';
import { SetupService } from '../setup/setup.service';
import type { CreateCoverDto, CreateCoverRangeDto, CoverQuery } from './dto/cover.dto';

/** Every calendar day in an inclusive range — the denominator `workingDaysBetween` filters down. */
function allDatesBetween(from: Date, to: Date): string[] {
  const days: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const last = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  while (cursor.getTime() <= last) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

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
    private readonly setup: SetupService,
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
    const { section, covering } = await this.validate(dto.sectionId, dto.coveringStaffId, [date]);

    // Find-then-write, not `upsert`: the tenant extension merges `schoolId` into the where clause
    // and breaks a compound unique selector — a documented trap in this codebase.
    const clash = await this.findClash(dto.sectionId, date, dto.periodNo ?? null);
    if (clash) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT,
        this.clashMessage(clash, section, dto.periodNo ?? null));
    }
    return this.insert(dto, date, section, covering);
  }

  /**
   * The same cover over a run of days — a teacher signed off sick until Thursday (Cover Plan, C1).
   *
   * **Skips rather than fails.** A range crosses weekly offs and closures, and one day in the
   * middle may already be covered by someone else; refusing the whole range because of day three
   * would send the office back to entering five days by hand. It answers with what it did and what
   * it did not, each with a reason — the partial-outcome shape §25.3 already uses for bulk
   * attendance.
   */
  async createRange(dto: CreateCoverRangeDto) {
    const from = new Date(dto.fromDate);
    const to = new Date(dto.toDate);
    if (to < from) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY,
        'The last day cannot be before the first');
    }
    // A grant that runs for months is not an absence, it is a reassignment — and it would be made
    // by holding a key down. The cap turns a slip into an error message.
    if ((to.getTime() - from.getTime()) / 86400000 > 30) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY,
        'Cover can be arranged up to 31 days at a time — a longer absence is a reassignment, not cover');
    }

    const settings = parseSchoolSettings((await this.db.school.findFirst({ where: { id: this.sid } }))?.settings ?? {});
    // Both endpoints, and that is enough: the payroll freeze is per month, and a range capped at
    // 31 days can straddle at most two of them — so `from` and `to` between them name every month
    // the grant touches.
    const { section, covering } = await this.validate(dto.sectionId, dto.coveringStaffId, [from, to]);
    const holidays = (await this.db.holiday.findMany({
      where: { date: { gte: from, lte: to }, OR: [{ campusId: section.class.campusId }, { campusId: null }] },
      select: { date: true },
    })).map((h) => new Date(h.date).toISOString().slice(0, 10));

    // The same calendar the register and payroll use. Arranging cover for a Sunday would put a
    // teacher's name against a day the school was shut.
    const workdays = workingDaysBetween(from, to, settings.weeklyOffDays, holidays);
    const skipped: { date: string; reason: string }[] = [];
    for (const iso of allDatesBetween(from, to)) {
      if (!workdays.includes(iso)) skipped.push({ date: iso, reason: 'School is closed that day' });
    }

    const created = [];
    for (const iso of workdays) {
      const date = new Date(iso);
      const clash = await this.findClash(dto.sectionId, date, dto.periodNo ?? null);
      if (clash) {
        skipped.push({ date: iso, reason: this.clashMessage(clash, section, dto.periodNo ?? null) });
        continue;
      }
      created.push(await this.insert({ ...dto, date: iso }, date, section, covering));
    }
    skipped.sort((a, b) => a.date.localeCompare(b.date));
    return { created, skipped };
  }

  /**
   * Who is away on a day, and which of their classes still needs somebody (Cover Plan, C1).
   *
   * **The office should not have to remember.** Both halves of the answer are already in the
   * database — the staff register says who did not come in, `TeacherAssignment` says whose classes
   * they are — so this derives the morning's worklist instead of asking an administrator to
   * reconstruct it from two other screens.
   *
   * **Approved leave is read as well as the register**, and that is the difference between this
   * being useful and being empty: leave is approved days in advance, the register is marked at
   * 08:00, and a school that keeps no staff register at all still approves leave. When the register
   * for the day is untouched, `staffRegisterMarked` is false so the screen can say *why* the list
   * is short rather than implying nobody is away.
   */
  async away(q: CoverQuery) {
    const date = new Date(q.date ?? new Date().toISOString().slice(0, 10));
    const restricted = restrictedCampusId(this.ctx.user);
    const yearId = await this.setup.requireCurrentYearId();

    const marked = await this.db.staffAttendance.findMany({
      where: { date },
      select: { staffId: true, status: true },
    });
    const leaves = await this.db.staffLeave.findMany({
      where: { status: 'APPROVED', fromDate: { lte: date }, toDate: { gte: date } },
      select: { staffId: true, leaveType: true },
    });

    // The register wins where both speak: it is the record of what actually happened, and an
    // approved leave someone worked through anyway is not an absence.
    const reasons = new Map<string, string>();
    for (const l of leaves) reasons.set(l.staffId, `On approved ${l.leaveType.toLowerCase()} leave`);
    for (const m of marked) {
      if (m.status === 'ABSENT') reasons.set(m.staffId, 'Marked absent');
      else if (m.status === 'ON_LEAVE') reasons.set(m.staffId, 'Marked on leave');
      else reasons.delete(m.staffId);
    }
    if (reasons.size === 0) return { date: q.date ?? date.toISOString().slice(0, 10), staffRegisterMarked: marked.length > 0, away: [] };

    const staff = await this.db.staffProfile.findMany({
      where: { id: { in: [...reasons.keys()] } },
      select: { id: true, fullName: true, employeeCode: true },
    });
    // Campus-scoped through the SECTIONS, not the staff member: `StaffProfile` has no campus, and
    // a teacher's campus is decided by what they teach. A campus admin therefore sees an away
    // colleague only when one of the classes at stake is theirs to arrange.
    const assignments = await this.db.teacherAssignment.findMany({
      where: {
        staffId: { in: [...reasons.keys()] },
        academicYearId: yearId,
        ...(restricted ? { section: { class: { campusId: restricted } } } : {}),
      },
      select: { staffId: true, section: { select: { id: true, name: true, class: { select: { id: true, name: true } } } } },
    });
    const cover = await this.db.coverAssignment.findMany({
      where: { date },
      select: { sectionId: true, coveringStaff: { select: { fullName: true, employeeCode: true } } },
    });
    const coveredBy = new Map(cover.map((c) => [c.sectionId, c.coveringStaff.fullName ?? c.coveringStaff.employeeCode]));

    const away = staff.map((s) => {
      // A teacher who teaches four subjects to one section appears in `TeacherAssignment` four
      // times; the office arranges cover for the class, once.
      const sections = new Map<string, { sectionId: string; className: string; sectionName: string; coveredBy: string | null }>();
      for (const a of assignments.filter((x) => x.staffId === s.id)) {
        sections.set(a.section.id, {
          sectionId: a.section.id,
          className: a.section.class.name,
          sectionName: a.section.name,
          coveredBy: coveredBy.get(a.section.id) ?? null,
        });
      }
      return {
        staffId: s.id,
        fullName: s.fullName,
        employeeCode: s.employeeCode,
        reason: reasons.get(s.id)!,
        sections: [...sections.values()].sort((a, b) => `${a.className}${a.sectionName}`.localeCompare(`${b.className}${b.sectionName}`)),
      };
    });

    return {
      date: date.toISOString().slice(0, 10),
      staffRegisterMarked: marked.length > 0,
      // A campus admin gets nothing for a colleague whose every class is at another campus, and an
      // away non-teaching staff member has no classes at all — neither is a row worth showing.
      away: away.filter((a) => a.sections.length > 0).sort((a, b) => (a.fullName ?? a.employeeCode).localeCompare(b.fullName ?? b.employeeCode)),
    };
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
   * Everything that has to be true before cover can exist at all — shared by the single day and
   * the range so the two cannot drift into enforcing different rules.
   *
   * `dates` is every day the grant would touch: the payroll freeze is per month, so a Wed–Tue
   * range has to be checked against both months, not just the first.
   */
  private async validate(sectionId: string, coveringStaffId: string, dates: Date[]) {
    const section = await this.db.section.findFirst({
      where: { id: sectionId },
      select: { id: true, name: true, class: { select: { name: true, campusId: true } } },
    });
    if (!section) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Section not found');
    assertCampusAccess(this.ctx.user, section.class.campusId);

    const covering = await this.db.staffProfile.findFirst({
      where: { id: coveringStaffId },
      select: { id: true, fullName: true, employeeCode: true, leftAt: true },
    });
    if (!covering) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Staff member not found');
    const coveringName = covering.fullName ?? covering.employeeCode;

    for (const date of dates) {
      if (covering.leftAt && covering.leftAt <= date) {
        throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY,
          `${coveringName} had left the school by that date`);
      }
      await this.assertPayrollOpen(date, section.class.campusId);
    }
    return { section, covering: { ...covering, name: coveringName } };
  }

  private findClash(sectionId: string, date: Date, periodNo: number | null) {
    return this.db.coverAssignment.findFirst({
      where: { sectionId, date, periodNo },
      include: { coveringStaff: { select: { fullName: true, employeeCode: true } } },
    });
  }

  /** Names the person, because the office's next move is to find out who — a code cannot say it. */
  private clashMessage(
    clash: { coveringStaff: { fullName: string | null; employeeCode: string } },
    section: { name: string; class: { name: string } },
    periodNo: number | null,
  ): string {
    const who = clash.coveringStaff.fullName ?? clash.coveringStaff.employeeCode;
    return `${who} is already covering ${section.class.name}-${section.name}${periodNo ? ` period ${periodNo}` : ' that day'}`;
  }

  private async insert(
    dto: { sectionId: string; date: string; coveringStaffId: string; periodNo?: number; absentStaffId?: string; reason?: string },
    date: Date,
    section: { name: string; class: { name: string } },
    covering: { name: string },
  ) {
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
    // has no FK to the entity, by design. One row per DAY, including inside a range: each day is a
    // separate grant of access to a separate register, and can be revoked on its own.
    await this.audit.record({
      action: AuditActions.COVER_ASSIGNED,
      entityType: 'CoverAssignment',
      entityId: created.id,
      newValue: {
        date: dto.date,
        section: `${section.class.name}-${section.name}`,
        periodNo: dto.periodNo ?? null,
        covering: covering.name,
        absent: created.absentStaff ? (created.absentStaff.fullName ?? created.absentStaff.employeeCode) : null,
        reason: dto.reason ?? null,
      },
    });
    return created;
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
