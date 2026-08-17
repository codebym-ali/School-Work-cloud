import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditActions,
  BellDayError,
  composeBellDay,
  ErrorCodes,
  TenantContext,
  assertCampusAccess,
  restrictedCampusId,
  teachingPeriodCount,
} from '@common';
import { AuditService, TenantPrismaService } from '@database';
import { SetupService } from '../setup/setup.service';
import type {
  BellScheduleQuery,
  CreateBellScheduleDto,
  SetBellDayDto,
  UpdateBellScheduleDto,
} from './dto/bell-schedule.dto';

/**
 * The school's own clock.
 *
 * `TimetableSlot` could always say *what* happens in period 3 and never *when*: `periodNo` is a bare
 * ordinal, and the grid inferred a class's period count from `max(periodNo)` over whatever had been
 * typed so far, floored at 6. A break could not be represented at all, and Friday — a short day in
 * almost every school here — rendered exactly like Tuesday.
 *
 * **The invariant this service exists to hold: exactly one schedule resolves for any section in any
 * academic year.** That is what keeps `periodNo` meaning one thing across the product, and it is why
 * `assertClassesUnattached` refuses at write time rather than letting a read-time precedence rule
 * pick a winner.
 *
 * Campus scoping is applied **here and not in a guard** (§22.8) — a guard runs before the
 * `withTenant` transaction, so it reads zero rows under RLS and waves everything through.
 */
@Injectable()
export class BellScheduleService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly setup: SetupService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }
  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  private static readonly INCLUDE = {
    campus: { select: { id: true, name: true } },
    classes: { select: { classId: true, class: { select: { id: true, name: true } } } },
    periods: { orderBy: [{ dayOfWeek: 'asc' as const }, { sequence: 'asc' as const }] },
  } satisfies Prisma.BellScheduleInclude;

  // ── reads ─────────────────────────────────────────────────────────────────

  /** Every schedule the caller may see, campus-scoped for a campus admin. */
  async list(q: BellScheduleQuery) {
    const academicYearId = q.academicYearId ?? (await this.setup.requireCurrentYearId());
    const restricted = restrictedCampusId(this.ctx.user);
    // A campus admin's own campus always wins over a campusId they asked for — the query parameter
    // narrows, it can never widen.
    const campusId = restricted ?? q.campusId;

    const schedules = await this.db.bellSchedule.findMany({
      where: { academicYearId, deletedAt: null, ...(campusId ? { campusId } : {}) },
      include: BellScheduleService.INCLUDE,
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    return { academicYearId, schedules: schedules.map((s) => this.shape(s)) };
  }

  async getOne(id: string) {
    return this.shape(await this.requireSchedule(id));
  }

  /**
   * Which schedule a section follows — the resolution the timetable grid renders from.
   *
   * Order: the schedule listing the section's class, else the campus default, else **none**. Null is
   * a real answer and callers must handle it: a school that has not set its timings keeps a fully
   * working timetable editor (the alternative would have turned this feature into a breaking change
   * on deploy for every existing school).
   */
  async resolveForSection(sectionId: string, academicYearId: string) {
    const section = await this.db.section.findFirst({
      where: { id: sectionId },
      select: { id: true, classId: true, class: { select: { campusId: true } } },
    });
    if (!section) return null;
    return this.resolveForClass(section.classId, section.class.campusId, academicYearId);
  }

  async resolveForClass(classId: string, campusId: string, academicYearId: string) {
    const attached = await this.db.bellSchedule.findFirst({
      where: { academicYearId, campusId, deletedAt: null, classes: { some: { classId } } },
      include: BellScheduleService.INCLUDE,
    });
    if (attached) return this.shape(attached);

    const fallback = await this.db.bellSchedule.findFirst({
      where: { academicYearId, campusId, deletedAt: null, isDefault: true },
      include: BellScheduleService.INCLUDE,
    });
    return fallback ? this.shape(fallback) : null;
  }

  // ── writes ────────────────────────────────────────────────────────────────

  async create(dto: CreateBellScheduleDto) {
    const academicYearId = dto.academicYearId ?? (await this.setup.requireCurrentYearId());
    assertCampusAccess(this.ctx.user, dto.campusId);

    const campus = await this.db.campus.findFirst({ where: { id: dto.campusId }, select: { id: true } });
    if (!campus) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Campus not found');

    const isDefault = dto.isDefault ?? false;
    const classIds = dto.classIds ?? [];

    // A non-default schedule nobody follows is unreachable — it would sit in the list looking
    // configured while every class kept using the default. Say so rather than saving a decoration.
    if (!isDefault && classIds.length === 0) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'A schedule must either be the campus default or list the classes that follow it.',
      );
    }
    if (isDefault && classIds.length > 0) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'The campus default applies to every class that is not on a wing schedule — it cannot list classes.',
      );
    }
    if (isDefault) await this.assertNoDefaultYet(dto.campusId, academicYearId, null);
    await this.assertClassesUnattached(classIds, dto.campusId, academicYearId, null);
    await this.assertNameFree(dto.name, dto.campusId, academicYearId, null);

    const schedule = await this.db.bellSchedule.create({
      data: {
        schoolId: this.sid,
        campusId: dto.campusId,
        academicYearId,
        name: dto.name.trim(),
        isDefault,
      },
      select: { id: true },
    });
    // ⚠️ Attachments are TOP-LEVEL creates, not a nested `classes: { create: [...] }`.
    // `BellScheduleClass` chains to its parent through the composite `(scheduleId, schoolId)` FK, so
    // Prisma derives `schoolId` from the parent in a nested create and rejects it as an unknown
    // argument — while a top-level create *requires* it, because the tenant extension asserts it.
    // The two shapes want opposite things; this is the trap recorded in Key Decisions, and the
    // first draft of this method walked straight into it.
    for (const classId of classIds) {
      await this.db.bellScheduleClass.create({ data: { schoolId: this.sid, scheduleId: schedule.id, classId } });
    }
    const created = await this.db.bellSchedule.findFirstOrThrow({
      where: { id: schedule.id },
      include: BellScheduleService.INCLUDE,
    });

    await this.audit.record({
      action: AuditActions.BELL_SCHEDULE_CREATED,
      entityType: 'BellSchedule',
      entityId: created.id,
      newValue: { name: created.name, campusId: created.campusId, isDefault, classIds },
    });
    return this.shape(created);
  }

  async update(id: string, dto: UpdateBellScheduleDto) {
    const schedule = await this.requireSchedule(id);

    if (dto.name !== undefined) {
      await this.assertNameFree(dto.name, schedule.campusId, schedule.academicYearId, schedule.id);
    }
    if (dto.classIds !== undefined) {
      if (schedule.isDefault && dto.classIds.length > 0) {
        throw new AppError(
          ErrorCodes.VALIDATION_FAILED,
          HttpStatus.UNPROCESSABLE_ENTITY,
          'The campus default applies to every class that is not on a wing schedule — it cannot list classes.',
        );
      }
      if (!schedule.isDefault && dto.classIds.length === 0) {
        throw new AppError(
          ErrorCodes.VALIDATION_FAILED,
          HttpStatus.UNPROCESSABLE_ENTITY,
          'Removing every class would leave this schedule with nobody following it.',
        );
      }
      await this.assertClassesUnattached(dto.classIds, schedule.campusId, schedule.academicYearId, schedule.id);
    }

    // Find-then-write throughout: `upsert` on a tenant model breaks, because the extension merges
    // schoolId into the where clause and the compound unique selector stops selecting.
    if (dto.classIds !== undefined) {
      await this.db.bellScheduleClass.deleteMany({ where: { scheduleId: schedule.id } });
      for (const classId of dto.classIds) {
        await this.db.bellScheduleClass.create({ data: { schoolId: this.sid, scheduleId: schedule.id, classId } });
      }
    }
    const updated = await this.db.bellSchedule.update({
      where: { id: schedule.id },
      data: { ...(dto.name !== undefined ? { name: dto.name.trim() } : {}) },
      include: BellScheduleService.INCLUDE,
    });

    await this.audit.record({
      action: AuditActions.BELL_SCHEDULE_UPDATED,
      entityType: 'BellSchedule',
      entityId: schedule.id,
      oldValue: { name: schedule.name, classIds: schedule.classes.map((c) => c.classId) },
      newValue: { name: updated.name, classIds: updated.classes.map((c) => c.classId) },
    });
    return this.shape(updated);
  }

  /**
   * Retire a schedule. Soft, like every other structural record here.
   *
   * Nothing is refused: sections that followed it fall back to the campus default, or to no schedule
   * at all — and "no schedule" is a supported state, not a broken one, so this cannot strand anybody.
   * The lessons already on the grid are untouched either way.
   */
  async remove(id: string) {
    const schedule = await this.requireSchedule(id);
    await this.db.bellSchedule.update({ where: { id: schedule.id }, data: { deletedAt: new Date() } });
    await this.audit.record({
      action: AuditActions.BELL_SCHEDULE_DELETED,
      entityType: 'BellSchedule',
      entityId: schedule.id,
      oldValue: { name: schedule.name, campusId: schedule.campusId, isDefault: schedule.isDefault },
    });
    return { deleted: true };
  }

  /**
   * Compose one day — the only way bell rows are ever written.
   *
   * Whole-day rather than per-row because a day-level invariant cannot be checked at row
   * granularity. The client sends `startsAt` plus a duration per row; `composeBellDay` walks the day
   * and produces the times, so gaps, overlaps and out-of-order rows are inexpressible rather than
   * rejected.
   */
  async setDay(id: string, dayOfWeek: number, dto: SetBellDayDto) {
    // The DB CHECK covers this too, but a constraint violation surfaces as a 500 — and the range is
    // in the URL, where a typo is likeliest.
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Day must be 1 (Monday) to 7 (Sunday).');
    }
    const schedule = await this.requireSchedule(id);

    let composed;
    try {
      composed = composeBellDay(dto.startsAt, dto.rows);
    } catch (e) {
      if (e instanceof BellDayError) {
        throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, e.message);
      }
      throw e;
    }

    const previous = schedule.periods.filter((p) => p.dayOfWeek === dayOfWeek);
    const newPeriodCount = teachingPeriodCount(composed);

    // ⚠️ Retained, never deleted. Shrinking a day (which is how a school runs Ramadan, since there
    // is deliberately no dated variant) leaves lessons sitting on periods the day no longer has.
    // They stay, they stop rendering, and they come back if the periods do — so a month of reduced
    // timings costs nobody their grid. The count is returned so the screen can say so out loud.
    const retainedLessons = await this.countLessonsBeyond(schedule, dayOfWeek, newPeriodCount);

    await this.db.bellPeriod.deleteMany({ where: { scheduleId: schedule.id, dayOfWeek } });
    for (const row of composed) {
      await this.db.bellPeriod.create({
        data: {
          schoolId: this.sid,
          scheduleId: schedule.id,
          dayOfWeek,
          sequence: row.sequence,
          isTeaching: row.isTeaching,
          periodNo: row.periodNo,
          label: row.label,
          startTime: row.startTime,
          endTime: row.endTime,
        },
      });
    }

    await this.audit.record({
      action: AuditActions.BELL_SCHEDULE_DAY_SET,
      entityType: 'BellSchedule',
      entityId: schedule.id,
      oldValue: { dayOfWeek, rows: previous.map((p) => this.auditRow(p)) },
      newValue: { dayOfWeek, rows: composed.map((p) => this.auditRow(p)) },
    });

    const fresh = await this.requireSchedule(id);
    return { ...this.shape(fresh), retainedLessons };
  }

  // ── invariants ────────────────────────────────────────────────────────────

  private async requireSchedule(id: string) {
    const schedule = await this.db.bellSchedule.findFirst({
      where: { id, deletedAt: null },
      include: BellScheduleService.INCLUDE,
    });
    if (!schedule) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Schedule not found');
    assertCampusAccess(this.ctx.user, schedule.campusId);
    return schedule;
  }

  private async assertNoDefaultYet(campusId: string, academicYearId: string, exceptId: string | null) {
    const existing = await this.db.bellSchedule.findFirst({
      where: { campusId, academicYearId, isDefault: true, deletedAt: null, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      select: { name: true },
    });
    if (existing) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        HttpStatus.CONFLICT,
        `This campus already has a default schedule ("${existing.name}") for the year.`,
      );
    }
  }

  private async assertNameFree(name: string, campusId: string, academicYearId: string, exceptId: string | null) {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'A schedule needs a name.');
    }
    const clash = await this.db.bellSchedule.findFirst({
      where: {
        campusId,
        academicYearId,
        deletedAt: null,
        name: { equals: trimmed, mode: 'insensitive' },
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (clash) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, `A schedule called "${trimmed}" already exists on this campus.`);
    }
  }

  /**
   * ⚠️ The invariant the whole model rests on: a class follows exactly one schedule.
   *
   * The `@@unique([classId, scheduleId])` on the join model only stops the same class being listed
   * twice on ONE schedule — it says nothing about two schedules of the same campus both claiming it,
   * which is precisely the case that would make `periodNo` ambiguous for that class's sections. So it
   * is checked here, and the error names the other schedule, because "already attached" leaves the
   * caller hunting for where.
   */
  private async assertClassesUnattached(
    classIds: string[],
    campusId: string,
    academicYearId: string,
    exceptScheduleId: string | null,
  ) {
    if (classIds.length === 0) return;

    const classes = await this.db.class.findMany({
      where: { id: { in: classIds } },
      select: { id: true, name: true, campusId: true },
    });
    if (classes.length !== new Set(classIds).size) {
      throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'One of those classes does not exist.');
    }
    // A class at another campus cannot follow this campus's bell — same shape as `assertSameCampus`
    // for teacher/section pairs: nobody's permissions are at fault, the pair is invalid.
    const foreign = classes.find((c) => c.campusId !== campusId);
    if (foreign) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        HttpStatus.UNPROCESSABLE_ENTITY,
        `${foreign.name} belongs to another campus, so it cannot follow this campus's timings.`,
      );
    }

    const taken = await this.db.bellScheduleClass.findFirst({
      where: {
        classId: { in: classIds },
        schedule: {
          campusId,
          academicYearId,
          deletedAt: null,
          ...(exceptScheduleId ? { NOT: { id: exceptScheduleId } } : {}),
        },
      },
      select: { classId: true, schedule: { select: { name: true } }, class: { select: { name: true } } },
    });
    if (taken) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        HttpStatus.CONFLICT,
        `${taken.class.name} already follows "${taken.schedule.name}". A class can only follow one schedule.`,
      );
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /**
   * How many lessons sit on periods this day will no longer have.
   *
   * Starts from the classes that FOLLOW this schedule — for a wing schedule that is its class list;
   * for the campus default it is every class on the campus not claimed by a wing — because a lesson
   * is only affected if its section actually rings to this bell.
   */
  private async countLessonsBeyond(
    schedule: { id: string; campusId: string; academicYearId: string; isDefault: boolean; classes: { classId: string }[] },
    dayOfWeek: number,
    newPeriodCount: number,
  ): Promise<number> {
    let classIds: string[];
    if (!schedule.isDefault) {
      classIds = schedule.classes.map((c) => c.classId);
    } else {
      const claimed = await this.db.bellScheduleClass.findMany({
        where: { schedule: { campusId: schedule.campusId, academicYearId: schedule.academicYearId, deletedAt: null } },
        select: { classId: true },
      });
      const claimedSet = new Set(claimed.map((c) => c.classId));
      const all = await this.db.class.findMany({ where: { campusId: schedule.campusId }, select: { id: true } });
      classIds = all.map((c) => c.id).filter((id) => !claimedSet.has(id));
    }
    if (classIds.length === 0) return 0;

    return this.db.timetableSlot.count({
      where: {
        academicYearId: schedule.academicYearId,
        dayOfWeek,
        periodNo: { gt: newPeriodCount },
        section: { classId: { in: classIds } },
      },
    });
  }

  private auditRow(p: { isTeaching: boolean; periodNo: number | null; label: string | null; startTime: string; endTime: string }) {
    return { label: p.isTeaching ? `Period ${p.periodNo}` : p.label, from: p.startTime, to: p.endTime };
  }

  /** One shape for every read, so the three screens cannot disagree about what a day looks like. */
  private shape(s: Prisma.BellScheduleGetPayload<{ include: typeof BellScheduleService.INCLUDE }>) {
    const days = Array.from({ length: 7 }, (_, i) => i + 1).map((dayOfWeek) => {
      const rows = s.periods.filter((p) => p.dayOfWeek === dayOfWeek);
      return {
        dayOfWeek,
        startsAt: rows[0]?.startTime ?? null,
        endsAt: rows[rows.length - 1]?.endTime ?? null,
        teachingPeriods: rows.filter((r) => r.isTeaching).length,
        rows: rows.map((r) => ({
          id: r.id,
          sequence: r.sequence,
          isTeaching: r.isTeaching,
          periodNo: r.periodNo,
          label: r.label,
          startTime: r.startTime,
          endTime: r.endTime,
        })),
      };
    });
    return {
      id: s.id,
      name: s.name,
      isDefault: s.isDefault,
      campusId: s.campusId,
      campusName: s.campus.name,
      academicYearId: s.academicYearId,
      classes: s.classes.map((c) => ({ id: c.class.id, name: c.class.name })),
      days,
    };
  }
}
