import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import {
  AppError,
  assertCampusAccess,
  AuditActions,
  effectiveCampusFilter,
  ErrorCodes,
  parseSchoolSettings,
  restrictedCampusId,
  TenantContext,
} from '@common';
import { AuditService, TenantPrismaService } from '@database';
import { SmsProducer } from '../comms/sms/sms-producer.service';
import type {
  CreateAcademicYearDto,
  CreateCampusDto,
  CreateClassDto,
  CreateHolidayDto,
  CreateHolidayRangeDto,
  CreateSectionDto,
  CreateSubjectDto,
  HolidayListQuery,
  UpdateCampusDto,
  UpdateClassDto,
  UpdateSectionDto,
  UpdateSubjectDto,
} from './dto/setup.dto';

/**
 * School setup (blueprint §24 Setup): academic years, campuses, classes, sections,
 * subjects — the structural data admissions/enrollment reference. All reads/writes
 * go through the tenant-bound client (RLS + extension scope every row to the school).
 */
export interface CoverageGap {
  classId: string; className: string;
  sectionId: string; sectionName: string;
  subjectId: string; subjectName: string;
}

@Injectable()
export class SetupService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly ctx: TenantContext,
    private readonly sms: SmsProducer,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  /** Current tenant id — passed explicitly on writes; the extension asserts it matches. */
  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  // ── School settings ──────────────────────────────────────────────────────────
  /**
   * The school's own configuration, with defaults filled in.
   *
   * `School.settings` had **no API at all** until now: every value — the working week, the fee
   * due day, whether teachers may check themselves in — could only be changed by a developer
   * writing to the database. That made a school's own operating rules something it had to ask
   * for, and it is how a demo tenant ended up marking a 19:18 check-in "late" against an 08:00
   * default nobody had ever been able to see, let alone change.
   */
  async getSettings() {
    const school = await this.db.school.findFirst({ where: { id: this.sid }, select: { settings: true } });
    return parseSchoolSettings(school?.settings ?? {});
  }

  /**
   * Merge a partial change into the settings blob (owner-only).
   *
   * **Merge, never replace.** The blob is one JSON column, so a PUT of the whole object would
   * mean any client that hadn't been updated for a newly-added key would silently reset it to
   * its default. Nested groups (`staffAttendance`, `staffLeaveQuotas`) merge one level down for
   * the same reason — sending `{ staffAttendance: { graceMinutes: 5 } }` must not wipe
   * `selfMarking`.
   *
   * The whole merged object is then validated by the Zod schema, so an invalid combination is
   * rejected as a unit rather than half-applied.
   */
  async updateSettings(patch: Record<string, unknown>) {
    const school = await this.db.school.findFirst({ where: { id: this.sid }, select: { settings: true } });
    const current = parseSchoolSettings(school?.settings ?? {}) as unknown as Record<string, unknown>;

    // ⚠️ Drop `undefined` FIRST, at every level. A class-validator DTO materialises every
    // declared property, so `{ ...dto }` carries a key for each setting the caller never
    // mentioned — and the nested DTOs do the same inside `staffAttendance`. Merging those writes
    // `undefined` over the current value and Zod then fills in the default, so changing one
    // field would quietly reset every other one. That is the exact "silently wipes it" failure
    // this merge exists to prevent, arriving through the front door.
    const changes = Object.entries(patch)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, isPlainObject(v) ? stripUndefined(v) : v] as const)
      // A nested group whose every field was absent is not a change at all.
      .filter(([, v]) => !isPlainObject(v) || Object.keys(v).length > 0);

    const merged: Record<string, unknown> = { ...current };
    for (const [key, value] of changes) {
      const existing = current[key];
      merged[key] = isPlainObject(value) && isPlainObject(existing)
        ? { ...existing, ...value }
        : value;
    }

    let next: ReturnType<typeof parseSchoolSettings>;
    try {
      next = parseSchoolSettings(merged);
    } catch (e) {
      const issue = e instanceof ZodError ? e.issues[0] : null;
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        HttpStatus.UNPROCESSABLE_ENTITY,
        issue ? `${issue.path.join('.') || 'settings'}: ${issue.message}` : 'Invalid settings',
        issue ? [{ field: issue.path.join('.') || 'settings', issue: issue.message }] : undefined,
      );
    }

    // Audit the DIFF, not the blob. These values govern money and pay, so "what changed" has to
    // be readable a year later without diffing two dumps by eye.
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [key] of changes) {
      const a = JSON.stringify(current[key]);
      const b = JSON.stringify((next as unknown as Record<string, unknown>)[key]);
      if (a !== b) {
        before[key] = current[key];
        after[key] = (next as unknown as Record<string, unknown>)[key];
      }
    }
    if (Object.keys(after).length === 0) return next; // nothing actually moved — don't audit a non-event

    await this.db.school.update({ where: { id: this.sid }, data: { settings: next as unknown as Prisma.InputJsonValue } });
    await this.audit.record({
      action: AuditActions.SCHOOL_SETTINGS_UPDATED,
      entityType: 'School',
      entityId: this.sid,
      oldValue: before,
      newValue: after,
    });
    return next;
  }

  // ── Academic years ─────────────────────────────────────────────────────────
  async createAcademicYear(dto: CreateAcademicYearDto) {
    const start = new Date(dto.startDate);
    const end = new Date(dto.endDate);
    if (end <= start) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'endDate must be after startDate');
    }
    // Years must not overlap (§7).
    const overlap = await this.db.academicYear.findFirst({
      where: { startDate: { lte: end }, endDate: { gte: start } },
    });
    if (overlap) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, `Overlaps existing year "${overlap.name}"`);
    }
    const year = await this.db.academicYear.create({
      data: { schoolId: this.sid, name: dto.name, startDate: start, endDate: end, isCurrent: false },
    });
    if (dto.isCurrent) await this.setCurrentAcademicYear(year.id);
    return this.db.academicYear.findFirst({ where: { id: year.id } });
  }

  listAcademicYears() {
    return this.db.academicYear.findMany({ orderBy: { startDate: 'desc' } });
  }

  /** Exactly one current year per school (partial unique): unset others, then set this. */
  async setCurrentAcademicYear(id: string) {
    const year = await this.db.academicYear.findFirst({ where: { id } });
    if (!year) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Academic year not found');
    await this.db.academicYear.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
    const updated = await this.db.academicYear.update({ where: { id }, data: { isCurrent: true } });
    await this.audit.record({
      action: AuditActions.ACADEMIC_YEAR_SET_CURRENT,
      entityType: 'AcademicYear',
      entityId: id,
      newValue: { name: year.name },
    });
    return updated;
  }

  /**
   * Does this section have room for one more child?
   *
   * ⚠️ **Lives here because it has two callers and must never have two implementations.** It began
   * as a private method on `StudentsService`, which is exactly why `POST /enrollments/transfer`
   * never had it: a 41st child could be *moved* into a 40-seat section that the admissions flow
   * would have refused. One rule, one place — the same discipline as `whoIsAway()` and
   * `myUnmarkedToday()`.
   *
   * `ADVISORY` deliberately allows the write and lets the UI warn: a school that has not opted into
   * a hard cap is telling you its class sizes are guidance, and refusing them would be the product
   * overruling the school about its own rooms.
   */
  async assertSectionHasRoom(sectionId: string, academicYearId: string, capacity: number): Promise<void> {
    const settings = parseSchoolSettings((await this.db.school.findFirst({ where: { id: this.ctx.requireSchoolId() } }))?.settings ?? {});
    if (settings.sectionCapacityMode !== 'HARD') return;
    const count = await this.db.studentEnrollment.count({
      where: { sectionId, academicYearId, status: 'ACTIVE' },
    });
    if (count >= capacity) {
      throw new AppError(ErrorCodes.SECTION_FULL, HttpStatus.UNPROCESSABLE_ENTITY, 'Section is at capacity');
    }
  }

  /** Resolve the school's current academic year id (used by admissions/enrollment). */
  async requireCurrentYearId(): Promise<string> {
    const year = await this.db.academicYear.findFirst({ where: { isCurrent: true } });
    if (!year) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'No current academic year set');
    }
    return year.id;
  }

  // ── Holidays / closures ────────────────────────────────────────────────────
  /**
   * School closures (G12). The `holidays` table existed from the start and was **read in five
   * places** — student marking, the coverage strip, the staff day summary, the day-close job and
   * payroll's working-day count — while **nothing anywhere could write it**. Every lookup found
   * nothing, so Eid was a working day: teachers chased for a register on a day the school was
   * shut, and payroll counting a holiday as a working day, which changes the per-day rate and
   * therefore every absence deduction that month.
   *
   * Two shapes, one row: a holiday planned weeks ahead, and "we are shut tomorrow" declared at
   * 21:00. The difference is timing, not mechanism.
   *
   * ⚠️ A closure NEVER deletes attendance. Declaring today closed after the morning register was
   * taken leaves those rows exactly as they are — it stops further marking and removes the day
   * from the payroll working-day count. Deleting would destroy what a teacher observed, and it
   * still could not un-send an absence SMS that already reached a parent.
   */
  async createHoliday(dto: CreateHolidayDto) {
    const date = new Date(dto.date.slice(0, 10));
    const campusId = await this.resolveClosureCampus(dto.campusId);
    await this.assertPayrollOpenForClosure(date, campusId);

    const name = dto.name.trim();
    const dup = await this.db.holiday.findFirst({ where: { date, campusId }, select: { id: true, name: true } });
    if (dup) {
      // A clean 409 rather than a raw unique-violation 500 — the lesson F6 taught on fee
      // structures. The message names what is already there, so it reads as a fact, not a bug.
      throw new AppError(
        ErrorCodes.CONFLICT,
        HttpStatus.CONFLICT,
        `${dto.date.slice(0, 10)} is already recorded as "${dup.name}".`,
      );
    }

    const holiday = await this.db.holiday.create({ data: { schoolId: this.sid, date, name, campusId } });
    await this.audit.record({
      action: AuditActions.HOLIDAY_DECLARED,
      entityType: 'Holiday',
      entityId: holiday.id,
      newValue: { date: dto.date.slice(0, 10), name, campusId },
    });
    if (dto.notifyGuardians) await this.notifyGuardiansOfClosure(holiday.id, date, name, campusId);
    return holiday;
  }

  /**
   * Fan a closure out to one SMS per enrolled student, when the office asked for it.
   *
   * ⚠️ **Per student, not per guardian, and that is the right unit** — two siblings share one
   * father, and the dispatcher's dedupe key is `SCHOOL_CLOSED:{holidayId}:{studentId}`, so he is
   * texted about each child. That is deliberate: collapsing to one message per phone number would
   * be cheaper, but a guardian with children at two campuses would then be told about a closure
   * that applies to only one of them, and a wrong closure notice is worse than a duplicate one.
   *
   * ⚠️ **Only ACTIVE enrolments in the current year.** A student who left in March must not be
   * texted about December, and a school still pays for every segment sent to them.
   *
   * ⚠️ **Never throws.** The closure is already recorded and audited by the time this runs. If the
   * SMS queue is unreachable, the school is still shut — failing the request here would make the
   * office think the closure did not save and declare it a second time.
   */
  private async notifyGuardiansOfClosure(
    holidayId: string,
    date: Date,
    reason: string,
    campusId: string | null,
  ): Promise<void> {
    try {
      const yearId = await this.requireCurrentYearId();
      const enrolments = await this.db.studentEnrollment.findMany({
        // A null campusId on the holiday means the whole school, so it contributes no filter.
        where: { academicYearId: yearId, status: 'ACTIVE', ...(campusId ? { campusId } : {}) },
        select: { studentId: true },
      });
      const iso = date.toISOString().slice(0, 10);
      for (const e of enrolments) {
        await this.sms.enqueueSchoolClosed({
          type: 'SCHOOL_CLOSED',
          schoolId: this.sid,
          studentId: e.studentId,
          holidayId,
          date: iso,
          reason,
        });
      }
    } catch {
      // Swallowed by design — see the note above.
    }
  }

  /**
   * A range, inclusive of both ends — winter break in one action rather than fourteen clicks.
   *
   * Days already closed are **skipped, not fatal**: a range crossing a holiday somebody already
   * recorded is the normal case, and rejecting the whole request would make the feature unusable
   * exactly when it is most useful. Follows the §25.3 partial-failure contract — the caller is
   * told what was created and what was skipped, and why.
   */
  async createHolidayRange(dto: CreateHolidayRangeDto) {
    const from = new Date(dto.fromDate.slice(0, 10));
    const to = new Date(dto.toDate.slice(0, 10));
    if (to < from) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'The end date is before the start date');
    }
    const days = Math.floor((to.getTime() - from.getTime()) / 86400000) + 1;
    if (days > 60) {
      // Guards a mis-typed year turning into 365 rows nobody meant.
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'A closure range may not exceed 60 days');
    }

    const campusId = await this.resolveClosureCampus(dto.campusId);
    const name = dto.name.trim();
    const created: string[] = [];
    const skipped: string[] = [];

    for (let i = 0; i < days; i++) {
      const date = new Date(from.getTime() + i * 86400000);
      const iso = date.toISOString().slice(0, 10);
      // Checked per DAY, not once for the range: a break spanning a month boundary can be half
      // inside a settled payroll month and half outside it.
      if (await this.isPayrollApproved(date, campusId)) { skipped.push(`${iso} (payroll approved)`); continue; }
      const dup = await this.db.holiday.findFirst({ where: { date, campusId }, select: { id: true } });
      if (dup) { skipped.push(`${iso} (already recorded)`); continue; }
      await this.db.holiday.create({ data: { schoolId: this.sid, date, name, campusId } });
      created.push(iso);
    }

    if (created.length) {
      await this.audit.record({
        action: AuditActions.HOLIDAY_DECLARED,
        entityType: 'Holiday',
        entityId: this.sid,
        newValue: { range: [dto.fromDate.slice(0, 10), dto.toDate.slice(0, 10)], name, campusId, created: created.length },
      });
    }
    return { created: created.length, skipped, dates: created };
  }

  /** The calendar. Campus-scoped — and a campus's calendar includes the school-wide closures. */
  async listHolidays(q: HolidayListQuery) {
    const campusId = effectiveCampusFilter(this.ctx.user, q.campusId);
    const from = q.from ? new Date(q.from.slice(0, 10)) : undefined;
    const to = q.to ? new Date(q.to.slice(0, 10)) : undefined;

    return this.db.holiday.findMany({
      where: {
        ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        // A school-wide closure (null campus) applies everywhere, so it must appear in a
        // campus-filtered calendar too — otherwise a campus admin finds Eid missing from theirs.
        ...(campusId ? { OR: [{ campusId }, { campusId: null }] } : {}),
      },
      orderBy: { date: 'asc' },
      include: { campus: { select: { name: true } } },
    });
  }

  /**
   * Remove a closure — which RE-OPENS the day, so it carries the same payroll refusal as
   * declaring one. Deleting a closure from a settled month moves the working-day count in the
   * other direction and breaks exactly the same payslips.
   */
  async deleteHoliday(id: string): Promise<void> {
    const holiday = await this.db.holiday.findFirst({ where: { id } });
    if (!holiday) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Closure not found');
    if (holiday.campusId) {
      assertCampusAccess(this.ctx.user, holiday.campusId);
    } else if (restrictedCampusId(this.ctx.user) !== null) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Only the school owner can remove a school-wide closure');
    }
    await this.assertPayrollOpenForClosure(holiday.date, holiday.campusId);

    await this.db.holiday.delete({ where: { id } });
    await this.audit.record({
      action: AuditActions.HOLIDAY_REMOVED,
      entityType: 'Holiday',
      entityId: id,
      oldValue: { date: holiday.date.toISOString().slice(0, 10), name: holiday.name, campusId: holiday.campusId },
    });
  }

  /**
   * Who the closure is for.
   *
   * A campus admin is **forced to their own campus** and can never declare school-wide: closing
   * the whole school would stop another campus's registers and move its payroll. Same §22.8 shape
   * as everywhere else, and in the service because it reads the caller's own binding.
   */
  private async resolveClosureCampus(requested?: string): Promise<string | null> {
    const restricted = restrictedCampusId(this.ctx.user);
    if (restricted === null) {
      if (!requested) return null; // owner, school-wide
      const campus = await this.db.campus.findFirst({ where: { id: requested }, select: { id: true } });
      if (!campus) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Campus not found');
      return campus.id;
    }
    if (requested && requested !== restricted) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'You can only declare a closure for your own campus');
    }
    return restricted;
  }

  private async isPayrollApproved(date: Date, campusId: string | null): Promise<boolean> {
    const run = await this.db.payrollRun.findFirst({
      where: {
        month: date.getUTCMonth() + 1,
        year: date.getUTCFullYear(),
        status: 'APPROVED',
        // A school-wide closure touches every campus, so ANY approved run that month blocks it.
        ...(campusId ? { campusId } : {}),
      },
      select: { id: true },
    });
    return run !== null;
  }

  /**
   * A closure changes the month's working-day count, which is the divisor for every absence
   * deduction. Once payroll is APPROVED the payslips are out, so the calendar has to stop moving
   * — the same freeze that already protects staff attendance (G1/G5), applied to the calendar.
   */
  private async assertPayrollOpenForClosure(date: Date, campusId: string | null): Promise<void> {
    if (!(await this.isPayrollApproved(date, campusId))) return;
    throw new AppError(
      ErrorCodes.CONFLICT,
      HttpStatus.CONFLICT,
      `Payroll for ${date.getUTCMonth() + 1}/${date.getUTCFullYear()} is already approved. `
        + 'Changing the calendar would change what people were already paid.',
    );
  }

  // ── Campuses ───────────────────────────────────────────────────────────────
  async createCampus(dto: CreateCampusDto) {
    const name = dto.name.trim();
    // Campus names are unique per school (case-insensitive) — no two same-named campuses.
    const dup = await this.db.campus.findFirst({ where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true } });
    if (dup) throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, `A campus named "${name}" already exists`);
    return this.db.campus.create({ data: { schoolId: this.sid, name, address: dto.address } });
  }

  /** Delete a campus only when nothing depends on it (no cascade — §17). Blocks with a
   *  clear reason if classes/users/records still belong to it. */
  async deleteCampus(id: string): Promise<void> {
    const campus = await this.db.campus.findFirst({ where: { id }, select: { id: true, name: true, address: true } });
    if (!campus) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Campus not found');

    // Every table that references campuses is counted here, so the error names the actual
    // blocker. Checking only classes+users let the request pass this guard and then fail on
    // the FK, surfacing a generic "other records" message that listed the wrong tables.
    // Only LIVE users block: counting soft-deleted ones made the campus undeletable forever
    // while the UI showed "No users yet" (that list filters deletedAt).
    const [classes, users, inquiries] = await Promise.all([
      this.db.class.count({ where: { campusId: id } }),
      this.db.user.count({ where: { campusId: id, deletedAt: null } }),
      this.db.inquiry.count({ where: { campusId: id } }),
    ]);
    const blockers: string[] = [];
    if (classes) blockers.push(`${classes} class(es)`);
    if (users) blockers.push(`${users} user(s)`);
    if (inquiries) blockers.push(`${inquiries} admission inquiry(ies)`);
    if (blockers.length) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, `Campus is in use — ${blockers.join(', ')} still belong to it. Remove or reassign them first.`);
    }

    try {
      // Removed accounts keep their campus_id, and that FK is RESTRICT — detach them or the
      // delete below fails on a reference to users nobody can see any more.
      await this.db.user.updateMany({ where: { campusId: id, deletedAt: { not: null } }, data: { campusId: null } });
      await this.db.campus.delete({ where: { id } });
      await this.audit.record({
        action: AuditActions.CAMPUS_DELETED,
        entityType: 'Campus',
        entityId: id,
        oldValue: { name: campus.name, address: campus.address },
      });
    } catch (e) {
      // Safety net only — the counts above cover every table that references campuses today,
      // so reaching here means a new reference was added without updating that list.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') {
        throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Campus is still referenced by other records. Remove them first.');
      }
      throw e;
    }
  }

  listCampuses() {
    return this.db.campus.findMany({ orderBy: { name: 'asc' } });
  }

  async updateCampus(id: string, dto: UpdateCampusDto) {
    await this.mustExist('campus', id);
    assertCampusAccess(this.ctx.user, id); // a campus-bound admin may only edit their own campus
    return this.db.campus.update({ where: { id }, data: dto });
  }

  // ── Classes ────────────────────────────────────────────────────────────────
  async createClass(dto: CreateClassDto) {
    await this.mustExist('campus', dto.campusId);
    assertCampusAccess(this.ctx.user, dto.campusId);
    if (dto.minAgeYears != null && dto.maxAgeYears != null && dto.maxAgeYears < dto.minAgeYears) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'maxAgeYears < minAgeYears');
    }
    return this.db.class.create({
      data: {
        schoolId: this.sid,
        campusId: dto.campusId,
        name: dto.name,
        order: dto.order,
        minAgeYears: dto.minAgeYears,
        maxAgeYears: dto.maxAgeYears,
      },
    });
  }

  listClasses(campusId?: string) {
    const effective = effectiveCampusFilter(this.ctx.user, campusId);
    return this.db.class.findMany({
      where: effective ? { campusId: effective } : {},
      orderBy: { order: 'asc' },
    });
  }

  // ── Sections ───────────────────────────────────────────────────────────────
  async createSection(dto: CreateSectionDto) {
    await this.assertClassCampus(dto.classId);
    const section = await this.db.section.create({
      data: { schoolId: this.sid, classId: dto.classId, name: dto.name, capacity: dto.capacity ?? 40 },
    });

    // Subject list: an explicit choice, or copied from a sibling section ("same as Section A").
    // Neither given ⇒ no rows ⇒ the section studies everything its class offers.
    let subjectIds = dto.subjectIds;
    if (!subjectIds && dto.copySubjectsFromSectionId) {
      const source = await this.db.section.findFirst({
        where: { id: dto.copySubjectsFromSectionId },
        select: { classId: true, subjects: { select: { subjectId: true } } },
      });
      if (!source) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Section to copy from not found');
      if (source.classId !== dto.classId) {
        throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Can only copy subjects from a section of the same class');
      }
      subjectIds = source.subjects.map((s) => s.subjectId);
    }

    if (subjectIds?.length) {
      // Every subject must belong to THIS class — otherwise a section could "study" a
      // subject from another class, which nothing downstream expects.
      const valid = await this.db.subject.findMany({
        where: { id: { in: subjectIds }, classId: dto.classId },
        select: { id: true },
      });
      if (valid.length !== subjectIds.length) {
        throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'One or more subjects do not belong to this class');
      }
      await this.db.sectionSubject.createMany({
        data: valid.map((s) => ({ schoolId: this.sid, sectionId: section.id, subjectId: s.id })),
      });
    }

    return section;
  }

  /** Replace a section's subject list (empty array ⇒ studies everything the class offers). */
  async setSectionSubjects(sectionId: string, subjectIds: string[]) {
    const section = await this.db.section.findFirst({ where: { id: sectionId }, select: { classId: true } });
    if (!section) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Section not found');
    await this.assertClassCampus(section.classId);

    if (subjectIds.length) {
      const valid = await this.db.subject.count({ where: { id: { in: subjectIds }, classId: section.classId } });
      if (valid !== subjectIds.length) {
        throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'One or more subjects do not belong to this class');
      }
    }
    await this.db.sectionSubject.deleteMany({ where: { sectionId } });
    if (subjectIds.length) {
      await this.db.sectionSubject.createMany({
        data: subjectIds.map((subjectId) => ({ schoolId: this.sid, sectionId, subjectId })),
      });
    }
    return { sectionId, subjectIds };
  }

  async listSections(classId?: string) {
    const restricted = restrictedCampusId(this.ctx.user);
    const rows = await this.db.section.findMany({
      where: { ...(classId ? { classId } : {}), ...(restricted ? { class: { campusId: restricted } } : {}) },
      orderBy: { name: 'asc' },
      include: { subjects: { select: { subjectId: true } } },
    });
    const year = await this.db.academicYear.findFirst({ where: { isCurrent: true }, select: { id: true } });
    const grouped = year && rows.length
      ? await this.db.studentEnrollment.groupBy({
          by: ['sectionId'],
          where: { academicYearId: year.id, status: 'ACTIVE', sectionId: { in: rows.map((r) => r.id) } },
          _count: { _all: true },
        })
      : [];
    const enrolled = new Map(grouped.map((g) => [g.sectionId, g._count._all]));
    // Flatten the link rows to plain ids — the client only ever needs the id list.
    return rows.map(({ subjects, ...s }) => ({
      ...s,
      subjectIds: subjects.map((x) => x.subjectId),
      enrolled: year ? enrolled.get(s.id) ?? 0 : null,
    }));
  }

  /**
   * Every (section, subject) pair with nobody assigned to teach it, this year.
   *
   * ⚠️ **The one implementation of this fact.** It used to be computed on the server (inside
   * `StaffService`) AND a second time in the browser, on `/classes`, by re-joining sections ×
   * subjects × assignments. Two implementations of one derivation is a defect the day it is
   * written — the audit's Law 4 — so the derivation lives here, on the Structure spine that owns
   * these tables, and both `/staff` and `/classes` consume the result. `StaffService.coverageGaps`
   * now delegates to this.
   *
   * Campus-scoped like every other oversight read. A section with no explicit `SectionSubject`
   * rows falls back to its class's subjects, because an empty set means "not configured yet", not
   * "teaches nothing".
   */
  async coverageGaps(): Promise<CoverageGap[]> {
    const restricted = restrictedCampusId(this.ctx.user);
    const year = await this.db.academicYear.findFirst({ where: { isCurrent: true }, select: { id: true } });
    if (!year) return [];

    const sections = await this.db.section.findMany({
      where: { class: restricted ? { campusId: restricted } : {} },
      include: {
        class: { select: { id: true, name: true, campusId: true } },
        subjects: { select: { subjectId: true } },
      },
    });
    if (!sections.length) return [];

    const [subjects, assignments] = await Promise.all([
      this.db.subject.findMany({ select: { id: true, name: true, classId: true } }),
      this.db.teacherAssignment.findMany({
        where: { academicYearId: year.id },
        select: { sectionId: true, subjectId: true },
      }),
    ]);
    const covered = new Set(assignments.filter((a) => a.subjectId).map((a) => `${a.sectionId}:${a.subjectId}`));
    const byId = new Map(subjects.map((s) => [s.id, s]));

    const gaps: CoverageGap[] = [];
    for (const sec of sections) {
      const own = sec.subjects.map((l) => l.subjectId);
      const taught = own.length ? own : subjects.filter((s) => s.classId === sec.class.id).map((s) => s.id);
      for (const subjectId of taught) {
        if (covered.has(`${sec.id}:${subjectId}`)) continue;
        gaps.push({
          classId: sec.class.id, className: sec.class.name,
          sectionId: sec.id, sectionName: sec.name,
          subjectId, subjectName: byId.get(subjectId)?.name ?? '—',
        });
      }
    }
    return gaps;
  }


  // ── Subjects ───────────────────────────────────────────────────────────────
  async createSubject(dto: CreateSubjectDto) {
    await this.assertClassCampus(dto.classId);
    return this.db.subject.create({
      data: {
        schoolId: this.sid,
        classId: dto.classId,
        name: normalizeSubjectName(dto.name),
        periodsPerWeek: dto.periodsPerWeek ?? null,
      },
    });
  }

  /**
   * Every subject the school teaches, grouped by NAME across classes — the cross-class view no
   * screen could show before, because a subject only ever lived inside one class's page.
   *
   * A `Subject` row is per class (Grade 9 · Chemistry and Grade 10 · Chemistry are two rows with one
   * name), so the coordinator's question "who teaches Chemistry, and where is it short" needs them
   * folded by name. `periodsPerWeek` is per class and may differ, so it travels per class rather than
   * being flattened.
   *
   * ⚠️ The teacher-gap count reuses `coverageGaps()` — the ONE implementation (IA1, Law 4) — so the
   * "3 sections without a teacher" here can never disagree with the same fact on /classes or /staff.
   */
  async subjectCatalogue() {
    const restricted = restrictedCampusId(this.ctx.user);
    const subjects = await this.db.subject.findMany({
      where: restricted ? { class: { campusId: restricted } } : {},
      select: { id: true, name: true, periodsPerWeek: true, classId: true, class: { select: { name: true } } },
      orderBy: { name: 'asc' },
    });

    const gaps = await this.coverageGaps();
    const gapsByName = new Map<string, number>();
    for (const g of gaps) gapsByName.set(g.subjectName, (gapsByName.get(g.subjectName) ?? 0) + 1);

    const byName = new Map<string, {
      name: string;
      classCount: number;
      sectionGaps: number;
      classes: { subjectId: string; classId: string; className: string; periodsPerWeek: number | null }[];
    }>();
    for (const s of subjects) {
      let e = byName.get(s.name);
      if (!e) {
        e = { name: s.name, classCount: 0, sectionGaps: gapsByName.get(s.name) ?? 0, classes: [] };
        byName.set(s.name, e);
      }
      e.classCount++;
      e.classes.push({ subjectId: s.id, classId: s.classId, className: s.class.name, periodsPerWeek: s.periodsPerWeek });
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  listSubjects(classId?: string) {
    const restricted = restrictedCampusId(this.ctx.user);
    return this.db.subject.findMany({
      where: { ...(classId ? { classId } : {}), ...(restricted ? { class: { campusId: restricted } } : {}) },
      orderBy: { name: 'asc' },
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────────
  /** A class exists and (for campus-bound users) belongs to the caller's campus. */
  // ── Renaming & removal ───────────────────────────────────────────────────────
  // Classes, sections and subjects were create-and-read only, so a mis-typed name was
  // permanent. Deletes are guarded by what actually USES the row, and the error names the
  // blocker. Note `teacher_assignments` and `timetable_slots` carry no FK to sections or
  // subjects, so the database will NOT stop an orphan — those counts are checked here.

  async updateClass(id: string, dto: UpdateClassDto) {
    await this.assertClassCampus(id);
    return this.db.class.update({
      where: { id },
      data: { name: dto.name, minAgeYears: dto.minAgeYears, maxAgeYears: dto.maxAgeYears, order: dto.order },
    });
  }

  async deleteClass(id: string): Promise<void> {
    await this.assertClassCampus(id);
    const klass = await this.db.class.findFirst({ where: { id }, select: { name: true, campusId: true } });
    if (!klass) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Class not found');
    const [sections, feeStructures, exams, batches, bellSchedules] = await Promise.all([
      this.db.section.count({ where: { classId: id } }),
      this.db.feeStructure.count({ where: { classId: id } }),
      this.db.examDefinition.count({ where: { classId: id } }),
      this.db.feeInvoiceBatch.count({ where: { classId: id } }),
      /**
       * ⚠️ **A bell-schedule link is a RESTRICT foreign key, and this guard did not know about it.**
       * Deleting a class attached to a schedule therefore skipped every friendly message here and
       * died on a raw constraint violation — a 500 where the whole point of this list is to answer
       * "why can't I delete this?" in words the office can act on.
       *
       * Counted against LIVE schedules only: see the `deleteMany` below for why a soft-deleted one
       * must not block anything.
       */
      this.db.bellScheduleClass.count({ where: { classId: id, schedule: { deletedAt: null } } }),
    ]);
    const blockers: string[] = [];
    if (sections) blockers.push(`${sections} section(s)`);
    if (feeStructures) blockers.push(`${feeStructures} fee structure(s)`);
    if (exams) blockers.push(`${exams} exam(s)`);
    if (batches) blockers.push(`${batches} fee batch(es)`);
    if (bellSchedules) blockers.push(`${bellSchedules} bell schedule(s)`);
    if (blockers.length) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT,
        `This class is in use — ${blockers.join(', ')} belong to it. Remove those first.`);
    }
    /**
     * ⚠️ **Links to a SOFT-DELETED schedule would otherwise block this class for ever.**
     * `BellScheduleService.remove` only stamps `deletedAt`, so the join rows survive a deletion the
     * user believes has happened — and because the class FK is RESTRICT, every class that schedule
     * touched became permanently undeletable with an opaque database error. The links are
     * unreachable once the schedule is gone (every read filters `deletedAt: null`), so removing
     * them here loses nothing and un-wedges the class.
     *
     * Safe by construction: we only reach this line when no LIVE schedule references the class.
     */
    await this.db.bellScheduleClass.deleteMany({ where: { classId: id } });

    // Its subjects are owned by the class and now provably unused (no sections ⇒ no
    // section links; exam results require an exam, and there are none).
    const subjectNames = (await this.db.subject.findMany({ where: { classId: id }, select: { name: true } })).map((x) => x.name);
    await this.db.subject.deleteMany({ where: { classId: id } });
    await this.db.class.delete({ where: { id } });
    await this.audit.record({
      action: AuditActions.CLASS_DELETED,
      entityType: 'Class',
      entityId: id,
      oldValue: { name: klass.name, campusId: klass.campusId, subjectsRemoved: subjectNames },
    });
  }

  async updateSection(id: string, dto: UpdateSectionDto) {
    const section = await this.db.section.findFirst({ where: { id }, select: { classId: true } });
    if (!section) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Section not found');
    await this.assertClassCampus(section.classId);
    return this.db.section.update({ where: { id }, data: { name: dto.name, capacity: dto.capacity } });
  }

  async deleteSection(id: string): Promise<void> {
    const sectionRow = await this.db.section.findFirst({ where: { id }, select: { name: true } });
    const section = await this.db.section.findFirst({ where: { id }, select: { classId: true } });
    if (!section) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Section not found');
    await this.assertClassCampus(section.classId);

    const [enrollments, assignments, slots] = await Promise.all([
      this.db.studentEnrollment.count({ where: { sectionId: id } }),
      this.db.teacherAssignment.count({ where: { sectionId: id } }),
      this.db.timetableSlot.count({ where: { sectionId: id } }),
    ]);
    const blockers: string[] = [];
    if (enrollments) blockers.push(`${enrollments} student enrolment(s)`);
    if (assignments) blockers.push(`${assignments} teacher assignment(s)`);
    if (slots) blockers.push(`${slots} timetable slot(s)`);
    if (blockers.length) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT,
        `This section is in use — ${blockers.join(', ')} belong to it. Move or remove those first.`);
    }
    await this.db.section.delete({ where: { id } }); // section_subjects cascade
    await this.audit.record({
      action: AuditActions.SECTION_DELETED,
      entityType: 'Section',
      entityId: id,
      oldValue: { name: sectionRow?.name, classId: section.classId },
    });
  }

  async updateSubject(id: string, dto: UpdateSubjectDto) {
    const subject = await this.db.subject.findFirst({ where: { id }, select: { classId: true } });
    if (!subject) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Subject not found');
    await this.assertClassCampus(subject.classId);
    return this.db.subject.update({
      where: { id },
      data: {
        name: dto.name ? normalizeSubjectName(dto.name) : undefined,
        // `undefined` leaves the load alone; `null` clears it. Those are different requests, so
        // the check is against `undefined` rather than falsiness — `?? undefined` would silently
        // turn "stop allocating a load for this subject" into a no-op.
        periodsPerWeek: dto.periodsPerWeek === undefined ? undefined : dto.periodsPerWeek,
      },
    });
  }

  async deleteSubject(id: string): Promise<void> {
    const subjectRow = await this.db.subject.findFirst({ where: { id }, select: { name: true } });
    const subject = await this.db.subject.findFirst({ where: { id }, select: { classId: true } });
    if (!subject) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Subject not found');
    await this.assertClassCampus(subject.classId);

    const [results, assignments, slots] = await Promise.all([
      this.db.examResult.count({ where: { subjectId: id } }),
      this.db.teacherAssignment.count({ where: { subjectId: id } }),
      this.db.timetableSlot.count({ where: { subjectId: id } }),
    ]);
    const blockers: string[] = [];
    if (results) blockers.push(`${results} exam result(s)`);
    if (assignments) blockers.push(`${assignments} teacher assignment(s)`);
    if (slots) blockers.push(`${slots} timetable slot(s)`);
    if (blockers.length) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT,
        `This subject is in use — ${blockers.join(', ')} reference it. Remove those first.`);
    }
    // Curriculum links are just "this section studies it" — safe to drop with the subject.
    await this.db.sectionSubject.deleteMany({ where: { subjectId: id } });
    await this.db.subject.delete({ where: { id } });
    await this.audit.record({
      action: AuditActions.SUBJECT_DELETED,
      entityType: 'Subject',
      entityId: id,
      oldValue: { name: subjectRow?.name, classId: subject.classId },
    });
  }

  private async assertClassCampus(classId: string): Promise<void> {
    const klass = await this.db.class.findFirst({ where: { id: classId }, select: { campusId: true } });
    if (!klass) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'class not found');
    assertCampusAccess(this.ctx.user, klass.campusId);
  }

  private async mustExist(model: 'campus' | 'class' | 'section', id: string): Promise<void> {
    const row = await (this.db[model] as { findFirst: (a: unknown) => Promise<unknown> }).findFirst({
      where: { id },
    });
    if (!row) {
      throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, `${model} not found`);
    }
  }
}

function normalizeSubjectName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** A JSON object (not null, not an array) — the only shape worth merging one level into. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Remove keys whose value is `undefined`, so an absent DTO field never overwrites a stored one. */
function stripUndefined(v: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined));
}
