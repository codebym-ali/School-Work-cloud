import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  assertCampusAccess,
  assertSameCampus,
  ErrorCodes,
  isAdminRole,
  restrictedCampusId,
  TenantContext,
} from '@common';
import { TenantPrismaService } from '@database';
import { BellScheduleService } from '../bell-schedule/bell-schedule.service';
import { SetupService } from '../setup/setup.service';
import type { SetSlotDto, TimetableQuery } from './dto/timetable.dto';

/** What one section's bell looks like, or null when the school has not set its timings. */
type ResolvedBell = Awaited<ReturnType<BellScheduleService['resolveForSection']>>;

/**
 * The weekly timetable (blueprint §23 "Teacher assignments & timetable"; the grid was marked
 * v1.5 there and is brought forward here).
 *
 * `timetable_slots` shipped in the first schema and stayed **a table nothing could write**: raw
 * ids, no relations, no endpoint. The only code that referenced it was two `count()` calls in
 * delete-guards asking whether a section had periods — a number that could only ever be zero, so
 * both guards were protecting against something that could not happen.
 *
 * Roles follow §23 exactly: OWNER_ADMIN full, CAMPUS_ADMIN their own campus, TEACHER reads their
 * own, STUDENT reads their own. The campus restriction is applied **in this service and not in a
 * guard** (§22.8) — guards run before the `withTenant` transaction, so a guard reading tenant data
 * sees zero rows under RLS and would wave everything through.
 */
@Injectable()
export class TimetableService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly setup: SetupService,
    private readonly bell: BellScheduleService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }
  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  /** Slot shape every read returns: enough to render a cell without a second call. */
  private static readonly INCLUDE = {
    subject: { select: { id: true, name: true } },
    staff: { select: { id: true, fullName: true, employeeCode: true } },
    section: { select: { id: true, name: true, class: { select: { id: true, name: true, campusId: true } } } },
  } satisfies Prisma.TimetableSlotInclude;

  /** One section's week. */
  async forSection(sectionId: string, q: TimetableQuery) {
    const section = await this.db.section.findFirst({
      where: { id: sectionId },
      select: { id: true, name: true, class: { select: { id: true, name: true, campusId: true } } },
    });
    if (!section) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Section not found');
    assertCampusAccess(this.ctx.user, section.class.campusId);

    const academicYearId = q.academicYearId ?? (await this.setup.requireCurrentYearId());
    const slots = await this.db.timetableSlot.findMany({
      where: { sectionId, academicYearId },
      include: TimetableService.INCLUDE,
      orderBy: [{ dayOfWeek: 'asc' }, { periodNo: 'asc' }],
    });
    // The grid's shape now comes from the school's declared day rather than from `max(periodNo)`
    // over whatever has been typed so far. `bell` is null for a school that has not set its
    // timings, and the client falls back to the old inferred shape — this must not become a
    // breaking change for a school with an existing grid and no schedule.
    const bell = await this.bell.resolveForSection(sectionId, academicYearId);
    return { sectionId, academicYearId, section, bell, slots: this.withTimes(slots, bell) };
  }

  /**
   * The caller's own week — a teacher's periods, or a student's.
   *
   * Self-scoped rather than role-scoped, so it needs no `@Roles`: a teacher can only ever be
   * resolved to their own staff profile, and a student to their own enrolment. Nobody can pass an
   * id to widen it, because the endpoint takes none.
   */
  async mine(q: TimetableQuery) {
    const user = this.ctx.user!;
    const academicYearId = q.academicYearId ?? (await this.setup.requireCurrentYearId());

    const staff = await this.db.staffProfile.findFirst({ where: { userId: user.userId }, select: { id: true } });
    if (staff) {
      const slots = await this.db.timetableSlot.findMany({
        where: { staffId: staff.id, academicYearId },
        include: TimetableService.INCLUDE,
        orderBy: [{ dayOfWeek: 'asc' }, { periodNo: 'asc' }],
      });
      // Per section, not per teacher: a teacher's week can legitimately cross a wing boundary, and
      // "period 3" is 10:20 on one side of it and 09:45 on the other.
      return { as: 'TEACHER' as const, academicYearId, slots: await this.withTimesAcrossSections(slots, academicYearId) };
    }

    const enrolment = await this.db.studentEnrollment.findFirst({
      where: { student: { userId: user.userId }, academicYearId, status: 'ACTIVE' },
      select: { sectionId: true },
    });
    // No staff profile and no active enrolment ⇒ nothing to show. Empty, not an error: this is
    // read by a portal page, and a 403 there would read as a fault rather than as "not yours".
    if (!enrolment) return { as: 'NONE' as const, academicYearId, slots: [] };

    const slots = await this.db.timetableSlot.findMany({
      where: { sectionId: enrolment.sectionId, academicYearId },
      include: TimetableService.INCLUDE,
      orderBy: [{ dayOfWeek: 'asc' }, { periodNo: 'asc' }],
    });
    const bell = await this.bell.resolveForSection(enrolment.sectionId, academicYearId);
    return { as: 'STUDENT' as const, academicYearId, bell, slots: this.withTimes(slots, bell) };
  }

  /**
   * Attach each lesson's clock time, read from the section's own bell.
   *
   * Done here rather than on each screen so `/timetable`, `/my-timetable` and `/me/timetable`
   * cannot disagree about when period 3 is — the same reason `lib/timetable.ts` exists on the
   * client. Null times are the honest answer for a school with no timings, not a zero.
   */
  private withTimes<T extends { dayOfWeek: number; periodNo: number }>(slots: T[], bell: ResolvedBell) {
    return slots.map((s) => {
      const row = bell?.days
        .find((d) => d.dayOfWeek === s.dayOfWeek)
        ?.rows.find((r) => r.periodNo === s.periodNo);
      return { ...s, startTime: row?.startTime ?? null, endTime: row?.endTime ?? null };
    });
  }

  /** The same, for lessons spanning several sections. One resolution per section, not per lesson. */
  private async withTimesAcrossSections<T extends { sectionId: string; dayOfWeek: number; periodNo: number }>(
    slots: T[],
    academicYearId: string,
  ) {
    const bells = new Map<string, ResolvedBell>();
    for (const sectionId of new Set(slots.map((s) => s.sectionId))) {
      bells.set(sectionId, await this.bell.resolveForSection(sectionId, academicYearId));
    }
    return slots.map((s) => this.withTimes([s], bells.get(s.sectionId) ?? null)[0]);
  }

  /**
   * Put a subject and a teacher in one cell (create or replace).
   *
   * Find-then-write rather than `upsert`: the Prisma tenant extension merges `schoolId` into the
   * where clause, which breaks a compound unique selector — a documented trap in this codebase,
   * not a style preference.
   */
  async setSlot(dto: SetSlotDto) {
    const academicYearId = dto.academicYearId ?? (await this.setup.requireCurrentYearId());

    const section = await this.db.section.findFirst({
      where: { id: dto.sectionId },
      select: { id: true, classId: true, class: { select: { campusId: true } } },
    });
    if (!section) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Section not found');
    assertCampusAccess(this.ctx.user, section.class.campusId);

    // The subject must belong to this section's class. Without this a timetable could schedule
    // Chemistry for a Grade 2 section — the ids would resolve, and the grid would look fine.
    const subject = await this.db.subject.findFirst({ where: { id: dto.subjectId }, select: { id: true, classId: true, name: true } });
    if (!subject) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Subject not found');
    if (subject.classId !== section.classId) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY,
        `${subject.name} is not taught in this class`);
    }

    const staff = await this.db.staffProfile.findFirst({
      where: { id: dto.staffId },
      select: { id: true, fullName: true, employeeCode: true, leftAt: true, user: { select: { campusId: true } } },
    });
    if (!staff) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Staff member not found');
    // The campus check above is about the CALLER, and an owner is school-wide — so nothing compared
    // the teacher to the class. A timetable that puts a campus-A teacher in a campus-B room is a
    // grid that renders perfectly and cannot be taught.
    assertSameCampus(staff.user?.campusId, section.class.campusId, staff.fullName ?? staff.employeeCode);
    // `fullName` is nullable on StaffProfile, and a clash message reading "null already teaches
    // 9-B" helps nobody — the employee code is always there and always identifies the person.
    const staffName = staff.fullName ?? staff.employeeCode;
    if (staff.leftAt) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY,
        `${staffName} has left the school`);
    }

    await this.assertPeriodExists(dto, academicYearId);
    await this.assertTeacherFree(dto, academicYearId, staffName);

    const existing = await this.db.timetableSlot.findFirst({
      where: { sectionId: dto.sectionId, academicYearId, dayOfWeek: dto.dayOfWeek, periodNo: dto.periodNo },
      select: { id: true },
    });
    const data = { subjectId: dto.subjectId, staffId: dto.staffId, room: dto.room ?? null };

    return existing
      ? this.db.timetableSlot.update({ where: { id: existing.id }, data, include: TimetableService.INCLUDE })
      : this.db.timetableSlot.create({
          data: {
            schoolId: this.sid,
            academicYearId,
            sectionId: dto.sectionId,
            dayOfWeek: dto.dayOfWeek,
            periodNo: dto.periodNo,
            ...data,
          },
          include: TimetableService.INCLUDE,
        });
  }

  /**
   * The period has to be one the school actually rings a bell for.
   *
   * ⚠️ **Conditional on a schedule existing, and that is the whole design.** A school that has not
   * set its timings resolves to `null` and keeps a fully working editor — exactly as before this
   * feature. An unconditional check would have meant every existing school woke up on deploy unable
   * to write to its own grid, which is an additive feature turned into a breaking change.
   *
   * The message names the count, because "period 6 does not exist" is only actionable next to
   * "Friday has 5 periods" — the day is short on purpose and the answer is usually to pick another
   * day, not to lengthen this one.
   */
  private async assertPeriodExists(dto: SetSlotDto, academicYearId: string): Promise<void> {
    const bell = await this.bell.resolveForSection(dto.sectionId, academicYearId);
    if (!bell) return;

    const day = bell.days.find((d) => d.dayOfWeek === dto.dayOfWeek);
    const teaching = day?.rows.filter((r) => r.isTeaching) ?? [];
    if (teaching.some((r) => r.periodNo === dto.periodNo)) return;

    const dayName = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][dto.dayOfWeek];
    throw new AppError(
      ErrorCodes.VALIDATION_FAILED,
      HttpStatus.UNPROCESSABLE_ENTITY,
      teaching.length === 0
        ? `${dayName} has no periods in "${bell.name}" — set the timings for that day first.`
        : `${dayName} has ${teaching.length} period${teaching.length === 1 ? '' : 's'} in "${bell.name}".`,
    );
  }

  /**
   * A teacher cannot be in two rooms at once.
   *
   * The database enforces the *section* side — `@@unique(sectionId, year, day, period)` — but the
   * teacher side has no equivalent constraint, because a teacher legitimately appears across many
   * sections. So it is checked here, and it is the check the model's
   * `@@index([schoolId, staffId, dayOfWeek])` was put there for long before anything used it.
   *
   * The error names the clash rather than saying "conflict": whoever is building a timetable needs
   * to know *which* class already has them, or they cannot resolve it without hunting.
   */
  private async assertTeacherFree(dto: SetSlotDto, academicYearId: string, staffName: string): Promise<void> {
    const clash = await this.db.timetableSlot.findFirst({
      where: {
        staffId: dto.staffId,
        academicYearId,
        dayOfWeek: dto.dayOfWeek,
        periodNo: dto.periodNo,
        // Replacing the cell you are already standing in is not a clash with yourself.
        NOT: { sectionId: dto.sectionId },
      },
      include: { section: { select: { name: true, class: { select: { name: true } } } } },
    });
    if (!clash) return;
    throw new AppError(
      ErrorCodes.CONFLICT,
      HttpStatus.CONFLICT,
      `${staffName} already teaches ${clash.section.class.name}-${clash.section.name} in period ${dto.periodNo} that day`,
    );
  }

  /** Empty one cell. Idempotent: clearing an empty cell is a no-op, not a 404. */
  async clearSlot(id: string) {
    const slot = await this.db.timetableSlot.findFirst({
      where: { id },
      select: { id: true, section: { select: { class: { select: { campusId: true } } } } },
    });
    if (!slot) return { deleted: false };
    assertCampusAccess(this.ctx.user, slot.section.class.campusId);
    await this.db.timetableSlot.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * Which sections have no timetable at all — the honest counterpart to a grid that renders empty.
   *
   * A blank grid cannot distinguish "not built yet" from "built and empty", and only the first is
   * worth chasing. Campus-scoped for a campus admin, like every other oversight read.
   */
  async coverage(q: TimetableQuery) {
    if (!isAdminRole(this.ctx.user)) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Admins only');
    }
    const academicYearId = q.academicYearId ?? (await this.setup.requireCurrentYearId());
    const restricted = restrictedCampusId(this.ctx.user);
    const sections = await this.db.section.findMany({
      where: { ...(restricted ? { class: { campusId: restricted } } : {}) },
      select: { id: true, name: true, class: { select: { name: true } } },
    });
    const counts = await this.db.timetableSlot.groupBy({
      by: ['sectionId'],
      where: { academicYearId, sectionId: { in: sections.map((s) => s.id) } },
      _count: { _all: true },
    });
    const bySection = new Map(counts.map((c) => [c.sectionId, c._count._all]));
    return {
      academicYearId,
      sections: sections
        .map((s) => ({ sectionId: s.id, className: s.class.name, sectionName: s.name, slots: bySection.get(s.id) ?? 0 }))
        .sort((a, b) => a.className.localeCompare(b.className) || a.sectionName.localeCompare(b.sectionName)),
    };
  }
}
