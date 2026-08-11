import { HttpStatus, Injectable } from '@nestjs/common';
import { AttendanceSource, AttendanceStatus, type AttendanceSession, type Prisma } from '@prisma/client';
import {
  AppError,
  assertCampusAccess,
  attendancePercentFromStatuses,
  AuditActions,
  checkInStatus,
  ErrorCodes,
  isPastLocalTime,
  parseSchoolSettings,
  restrictedCampusId,
  TenantContext,
  workingDaysBetween,
  type RequestUser,
} from '@common';
import { AuditService, TenantPrismaService } from '@database';
import { CoverService } from '../cover/cover.service';
import { SetupService } from '../setup/setup.service';
import { SmsProducer } from '../comms/sms/sms-producer.service';
import type {
  AttendanceQuery,
  MarkAttendanceDto,
  MarkStaffAttendanceDto,
  PatchAttendanceDto,
} from './dto/attendance.dto';

const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;

export interface BulkResult {
  succeeded: number;
  failed: number;
  errors: Array<{ index: number; code: string; message: string }>;
  absenceQueued: number;
  /** Absences recorded on a past date, deliberately not announced to guardians. Optional
   *  because staff attendance shares this shape and notifies nobody — the field would be
   *  meaningless there, not merely zero. */
  absenceNotifiedSuppressed?: number;
}

/**
 * Attendance marking (blueprint §9): one record per (enrollment, date, session);
 * future/holiday/weekly-off validation; edit-lock window; cross-teacher conflict;
 * partial-failure contract (§25.3); absence-SMS enqueue for newly-ABSENT students.
 */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly audit: AuditService,
    private readonly setup: SetupService,
    private readonly sms: SmsProducer,
    // Cover is the second way a teacher may mark a section (Cover Plan, C0).
    private readonly cover: CoverService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  async markBulk(dto: MarkAttendanceDto): Promise<BulkResult> {
    const schoolId = this.ctx.requireSchoolId();
    const user = this.ctx.user!;
    const date = new Date(dto.date);
    if (startOfDay(date) > startOfDay(new Date())) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Date is in the future');
    }

    const school = await this.db.school.findFirst({ where: { id: schoolId } });
    const settings = parseSchoolSettings(school?.settings ?? {});
    if (!settings.attendanceSessions.includes(dto.session)) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Session not configured for this school');
    }

    // Backfill floor: a teacher may fill in a day they missed, but not rewrite history. Only
    // the FUTURE was blocked before, so attendance could be created for any past date at all —
    // and attendance feeds payroll deductions and defaulter reporting. Admins stay unlimited
    // (their post-window edits are already audited).
    const age = daysSince(date);
    if (!isAdmin(user) && age > settings.attendanceBackfillDays) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        HttpStatus.UNPROCESSABLE_ENTITY,
        `Attendance can only be marked up to ${settings.attendanceBackfillDays} days back. Ask an admin to record ${dto.date}.`,
      );
    }

    const section = await this.db.section.findFirst({
      where: { id: dto.sectionId },
      include: { class: { select: { campusId: true } } },
    });
    if (!section) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Section not found');
    // Campus scoping (§22.8, P1.7): a campus-bound admin may only mark their own campus.
    assertCampusAccess(user, section.class.campusId);

    const reason = await this.nonWorkingReason(date, section.class.campusId, settings.weeklyOffDays);
    if (reason && !dto.allowHolidayOverride) {
      // Name the closure. "Holiday/weekly-off day" reads as a broken button; "School closed:
      // Eid ul Adha" is a fact the teacher can act on — and if it is wrong, argue with.
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        HttpStatus.UNPROCESSABLE_ENTITY,
        reason.kind === 'HOLIDAY'
          ? `School closed: ${reason.name}. An admin can override if the register really was taken.`
          : 'This is a weekly off. An admin can override if the register really was taken.',
      );
    }
    if (reason && dto.allowHolidayOverride && !isAdmin(user)) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Only an admin may override holiday marking');
    }

    await this.assertCanMark(dto.sectionId, user, date);
    const currentYearId = await this.setup.requireCurrentYearId();

    const errors: BulkResult['errors'] = [];
    let succeeded = 0;
    const newlyAbsent: Array<{ enrollmentId: string; studentId: string }> = [];
    const editWindow = settings.attendanceEditWindowDays;
    const withinWindow = daysSince(date) <= editWindow;

    for (let i = 0; i < dto.records.length; i++) {
      const rec = dto.records[i];
      // `student.deletedAt: null` blocks marking a soft-deleted student whose enrollment row
      // is still ACTIVE (stale) — a null result falls through to the same validation error.
      const enr = await this.db.studentEnrollment.findFirst({ where: { id: rec.enrollmentId, student: { deletedAt: null } } });
      if (!enr || enr.status !== 'ACTIVE' || enr.sectionId !== dto.sectionId || enr.academicYearId !== currentYearId) {
        errors.push({ index: i, code: ErrorCodes.VALIDATION_FAILED, message: 'Enrollment not ACTIVE in this section/year' });
        continue;
      }
      // The enrolment must have been active ON THAT DATE, not merely active now. Without this,
      // backfilling a week marks a student admitted yesterday as present for days before they
      // joined — inventing a record of a child who wasn't there.
      if (startOfDay(enr.startedAt) > startOfDay(date) || (enr.endedAt && startOfDay(enr.endedAt) < startOfDay(date))) {
        errors.push({
          index: i,
          code: ErrorCodes.VALIDATION_FAILED,
          message: `Student was not enrolled in this section on ${dto.date}`,
        });
        continue;
      }
      const existing = await this.db.attendanceRecord.findFirst({
        where: { enrollmentId: rec.enrollmentId, date, session: dto.session },
      });

      if (!existing) {
        await this.db.attendanceRecord.create({
          data: { schoolId, enrollmentId: rec.enrollmentId, date, session: dto.session, status: rec.status, markedById: user.userId },
        });
        succeeded++;
        if (rec.status === AttendanceStatus.ABSENT) newlyAbsent.push({ enrollmentId: enr.id, studentId: enr.studentId });
        continue;
      }
      if (existing.lockedByLeaveId) {
        errors.push({ index: i, code: ErrorCodes.ATTENDANCE_LOCKED, message: 'Locked by an approved leave' });
        continue;
      }
      if (existing.status === rec.status) {
        succeeded++; // idempotent resubmit, no change
        continue;
      }
      const sameUser = existing.markedById === user.userId;
      if (isAdmin(user) || (sameUser && withinWindow)) {
        await this.db.attendanceRecord.update({ where: { id: existing.id }, data: { status: rec.status, markedById: user.userId } });
        if (isAdmin(user) && !withinWindow) {
          await this.audit.record({
            action: AuditActions.ATTENDANCE_EDITED_POST_WINDOW,
            entityType: 'AttendanceRecord',
            entityId: existing.id,
            oldValue: { status: existing.status },
            newValue: { status: rec.status },
          });
        }
        succeeded++;
        if (rec.status === AttendanceStatus.ABSENT) newlyAbsent.push({ enrollmentId: enr.id, studentId: enr.studentId });
      } else {
        errors.push({
          index: i,
          code: withinWindow ? ErrorCodes.ATTENDANCE_CONFLICT : ErrorCodes.ATTENDANCE_LOCKED,
          message: `Existing value ${existing.status} was marked by another user`,
        });
      }
    }

    // Enqueue absence SMS once per newly-ABSENT enrollment (dedup by BullMQ jobId) — but ONLY
    // for today. An absence alert exists so a parent can act the same day ("where is my
    // child?"); sent a week later it is accurate and useless. Worse, backfilling one week for
    // one section would burst 30+ texts about days everyone already knows about, spending real
    // credits. The record is still written — only the notification is withheld.
    const isToday = age === 0;
    if (isToday) {
      for (const a of newlyAbsent) {
        await this.sms.enqueueAbsence({ type: 'ABSENCE', schoolId, enrollmentId: a.enrollmentId, studentId: a.studentId, date: dto.date });
      }
    }

    return {
      succeeded,
      failed: errors.length,
      errors,
      absenceQueued: isToday ? newlyAbsent.length : 0,
      /** Lets the UI say plainly that a backfilled absence was recorded but not announced. */
      absenceNotifiedSuppressed: isToday ? 0 : newlyAbsent.length,
    };
  }

  /**
   * Which of the last N days this section has attendance for — the data behind the "you missed
   * Wednesday" strip.
   *
   * Backfill is only usable if the teacher can SEE which days are missing; expecting them to
   * remember, then navigate date by date, is why catch-up doesn't happen. Non-working days are
   * returned as such rather than as gaps, or the strip cries wolf every Sunday and gets ignored.
   *
   * `marked` vs `expected` distinguishes a day that was half-done (interrupted mid-register)
   * from one never started — different problems needing different effort.
   */
  async coverage(sectionId: string, session: AttendanceSession, days: number) {
    const section = await this.db.section.findFirst({
      where: { id: sectionId },
      include: { class: { select: { campusId: true } } },
    });
    if (!section) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Section not found');
    assertCampusAccess(this.ctx.user, section.class.campusId);

    const school = await this.db.school.findFirst({ where: { id: this.ctx.requireSchoolId() } });
    const settings = parseSchoolSettings(school?.settings ?? {});
    const academicYearId = await this.setup.requireCurrentYearId();

    // `startOfDay` returns a UTC timestamp, not a Date — build the day list from that so the
    // whole method compares like with like.
    const todayMs = startOfDay(new Date());
    const dates: Date[] = [];
    for (let i = days - 1; i >= 0; i--) dates.push(new Date(todayMs - i * 86400000));

    const [counts, enrolments] = await Promise.all([
      this.db.attendanceRecord.groupBy({
        by: ['date'],
        where: { date: { gte: dates[0] }, session, enrollment: { sectionId, academicYearId } },
        _count: { _all: true },
      }),
      this.db.studentEnrollment.findMany({
        where: { sectionId, academicYearId, status: 'ACTIVE', student: { deletedAt: null } },
        select: { startedAt: true },
      }),
    ]);
    const markedBy = new Map(counts.map((c) => [startOfDay(c.date), c._count._all]));

    return Promise.all(
      dates.map(async (d) => {
        const reason = await this.nonWorkingReason(d, section.class.campusId, settings.weeklyOffDays);
        const working = reason === null;
        // Expected head-count is per-day: a student who joined on Thursday was never owed a
        // Monday mark, so counting them would leave the day permanently "incomplete".
        const expected = working ? enrolments.filter((e) => startOfDay(e.startedAt) <= startOfDay(d)).length : 0;
        return {
          date: d.toISOString().slice(0, 10),
          working,
          // The strip greys a day out either way; naming it is the difference between "why can't
          // I mark this?" and "of course, that was Eid".
          closedFor: reason?.kind === 'HOLIDAY' ? reason.name : null,
          marked: markedBy.get(startOfDay(d)) ?? 0,
          expected,
        };
      }),
    );
  }

  /**
   * Which sections have not had today's register marked (G3).
   *
   * **Starts from the SECTIONS, not from the attendance table** — the same rule the staff
   * register had to learn. A query over `attendance_records` can only return registers somebody
   * already filled in; the ones worth chasing are precisely the ones it omits.
   *
   * Surfaces, never polices. Nothing here blocks marking, derives a status or messages anyone:
   * it answers "who hasn't done it yet", and only once the school's own `attendanceMarkByTime`
   * has passed — before that a blank register is a lesson that hasn't happened yet, and a system
   * that complains then gets ignored when it matters.
   *
   * `partial` is distinguished from untouched: a register interrupted halfway is a different
   * problem from one never started, and needs a different word from whoever chases it.
   */
  async unmarkedToday() {
    const schoolId = this.ctx.requireSchoolId();
    const school = await this.db.school.findFirst({ where: { id: schoolId } });
    const settings = parseSchoolSettings(school?.settings ?? {});
    const session = settings.attendanceSessions[0];
    const academicYearId = await this.setup.requireCurrentYearId();

    const now = new Date();
    // The SCHOOL's clock, not the server's (G4). A 13:00 school in another zone would otherwise
    // have its registers judged late at the wrong moment, with nothing in the output to hint the
    // comparison was against the wrong clock.
    const due = isPastLocalTime(now, settings.attendanceMarkByTime, settings.timezone);
    const date = new Date(startOfDay(now));

    // ⚠️ `startedAt` is a full timestamp, not a date, so `startedAt <= <midnight>` excludes anyone
    // enrolled *earlier today* — and the two other places that ask "was this enrolment active on
    // day D" normalise both sides first (`startOfDay(enr.startedAt) <= startOfDay(date)`, marking
    // and the coverage strip). The raw comparison here meant a student admitted this morning could
    // have their attendance marked while their register never appeared as outstanding. Comparing
    // against the START OF TOMORROW is the same question asked in SQL.
    const beforeTomorrow = new Date(startOfDay(date) + 86400000);
    const restricted = restrictedCampusId(this.ctx.user);
    const sections = await this.db.section.findMany({
      where: { ...(restricted ? { class: { campusId: restricted } } : {}) },
      select: { id: true, name: true, class: { select: { name: true, campusId: true } } },
    });

    const rows = await Promise.all(
      sections.map(async (s) => {
        // A holiday or weekly off is not a gap. Crying wolf every Sunday is how a warning
        // becomes wallpaper — the coverage strip learned this first.
        if (await this.isNonWorkingDay(date, s.class.campusId, settings.weeklyOffDays)) return null;

        const [expected, marked] = await Promise.all([
          this.db.studentEnrollment.count({
            where: { sectionId: s.id, academicYearId, status: 'ACTIVE', student: { deletedAt: null }, startedAt: { lt: beforeTomorrow } },
          }),
          this.db.attendanceRecord.count({
            where: { date, session, enrollment: { sectionId: s.id, academicYearId } },
          }),
        ]);
        // A section with nobody in it cannot be behind on anything.
        if (expected === 0 || marked >= expected) return null;
        return {
          sectionId: s.id,
          className: s.class.name,
          sectionName: s.name,
          expected,
          marked,
          partial: marked > 0,
        };
      }),
    );

    const outstanding = rows.filter((r): r is NonNullable<typeof r> => r !== null);
    // Who actually holds each of these registers today (Cover Plan §6a). A covered-but-unmarked
    // register is still worth chasing — but the person to chase is the cover, and a row naming the
    // teacher who was away sends the head to somebody who could not have marked it.
    const coveredBy = await this.cover.coveredByBySection(outstanding.map((r) => r.sectionId), date);
    return {
      /** Whether the school's own deadline has passed yet — the UI stays quiet until it has. */
      due,
      markByTime: settings.attendanceMarkByTime,
      count: outstanding.length,
      sections: outstanding
        .map((r) => ({ ...r, coveredBy: coveredBy.get(r.sectionId) ?? null }))
        .sort((a, b) => a.className.localeCompare(b.className) || a.sectionName.localeCompare(b.sectionName)),
    };
  }

  async query(q: AttendanceQuery) {
    const where: Prisma.AttendanceRecordWhereInput = {};
    if (q.date) where.date = new Date(q.date);
    // Campus scoping (§22.8, P1.7): force a campus-bound admin's campus onto the
    // enrollment relation so the list can never spill another campus's records.
    const restricted = restrictedCampusId(this.ctx.user);
    const enroll: Prisma.StudentEnrollmentWhereInput = {};
    if (q.sectionId) enroll.sectionId = q.sectionId;
    if (q.studentId) enroll.studentId = q.studentId;
    if (restricted !== null) enroll.campusId = restricted;
    if (q.sectionId || q.studentId || restricted !== null) where.enrollment = enroll;
    if (q.from || q.to) {
      where.date = {
        ...(q.from ? { gte: new Date(q.from) } : {}),
        ...(q.to ? { lte: new Date(q.to) } : {}),
      };
    }
    return this.db.attendanceRecord.findMany({ where, orderBy: { date: 'desc' }, take: 500 });
  }

  /** Admin post-window edit (blueprint §9): requires a reason, writes AuditLog. */
  async patch(id: string, dto: PatchAttendanceDto) {
    const existing = await this.db.attendanceRecord.findFirst({
      where: { id },
      include: { enrollment: { select: { campusId: true } } },
    });
    if (!existing) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Attendance record not found');
    // Campus scoping (§22.8, P1.7): a campus-bound admin may only edit their campus.
    assertCampusAccess(this.ctx.user, existing.enrollment.campusId);
    const updated = await this.db.attendanceRecord.update({
      where: { id },
      data: { status: dto.status, markedById: this.ctx.user!.userId },
    });
    await this.audit.record({
      action: AuditActions.ATTENDANCE_EDITED_POST_WINDOW,
      entityType: 'AttendanceRecord',
      entityId: id,
      oldValue: { status: existing.status },
      newValue: { status: dto.status },
      reason: dto.reason,
    });
    return updated;
  }

  // ── Staff attendance ─────────────────────────────────────────────────────────
  /**
   * The office records staff attendance for a day (§9/§13).
   *
   * This used to validate **nothing**: any date including the future, any staff member in any
   * campus, no working-day check, no audit, and it returned the partial-failure shape (§25.3)
   * while never populating it. That mattered more than it looked, because
   * `payroll.absentDays()` counts these rows straight into the salary deduction — so a
   * mis-keyed date or another campus's staff list moved somebody's pay.
   *
   * Now mirrors the student register: campus-scoped per row, no future dates, non-working days
   * refused unless an admin overrides, one bad row never rejects the rest, provenance recorded,
   * and overriding somebody's own SELF claim is audited.
   */
  async markStaffBulk(dto: MarkStaffAttendanceDto): Promise<BulkResult> {
    const schoolId = this.ctx.requireSchoolId();
    const user = this.ctx.user!;
    const date = new Date(dto.date);
    if (startOfDay(date) > startOfDay(new Date())) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Date is in the future');
    }

    const school = await this.db.school.findFirst({ where: { id: schoolId } });
    const settings = parseSchoolSettings(school?.settings ?? {});
    if (!settings.attendanceSessions.includes(dto.session)) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Session not configured for this school');
    }

    // Freeze the month once payroll has been approved for it: the payslip was computed FROM
    // these rows, so letting them move afterwards leaves a paid payslip disagreeing with its
    // own register and neither number trustworthy. Reversing the run is the explicit path.
    //
    // Resolved once, applied PER ROW below, because the freeze is per campus and a bulk
    // register may span several — one frozen campus must not reject another's rows.
    const frozenCampuses = await this.frozenCampusIds(date);

    const restricted = restrictedCampusId(user);
    const errors: BulkResult['errors'] = [];
    let succeeded = 0;

    for (let i = 0; i < dto.records.length; i++) {
      const rec = dto.records[i];
      const staff = await this.db.staffProfile.findFirst({
        where: { id: rec.staffId },
        select: { id: true, joinedAt: true, leftAt: true, user: { select: { campusId: true } } },
      });
      if (!staff) {
        errors.push({ index: i, code: ErrorCodes.NOT_FOUND, message: 'Staff member not found' });
        continue;
      }
      // §22.8 / P1.7 — a campus-bound admin marking another campus's staff was previously
      // accepted outright. Per row, because the list is a mixed set of ids from the client.
      if (restricted && staff.user.campusId !== restricted) {
        errors.push({ index: i, code: ErrorCodes.FORBIDDEN, message: 'This staff member is in another campus' });
        continue;
      }
      // Was this person employed on THAT date — not merely employed now. Same rule the student
      // register applies to enrolments: a backdated write must ask "was this true then?".
      if (startOfDay(staff.joinedAt) > startOfDay(date) || (staff.leftAt && startOfDay(staff.leftAt) < startOfDay(date))) {
        errors.push({ index: i, code: ErrorCodes.VALIDATION_FAILED, message: `Not employed on ${dto.date}` });
        continue;
      }

      const campusId = staff.user.campusId;
      // Their campus's payroll is settled for this month; theirs alone is refused.
      if (campusId && frozenCampuses.has(campusId)) {
        errors.push({ index: i, code: ErrorCodes.CONFLICT, message: this.payrollFrozenMessage(date) });
        continue;
      }

      // Working-day check is per campus (holidays can be campus-specific), so it sits inside
      // the loop rather than above it.
      const off = campusId ? await this.isNonWorkingDay(date, campusId, settings.weeklyOffDays) : false;
      if (off && !dto.allowHolidayOverride) {
        errors.push({ index: i, code: ErrorCodes.VALIDATION_FAILED, message: 'Holiday or weekly-off day; override required' });
        continue;
      }

      const existing = await this.db.staffAttendance.findFirst({
        where: { staffId: rec.staffId, date, session: dto.session },
      });
      if (!existing) {
        await this.db.staffAttendance.create({
          data: {
            schoolId, staffId: rec.staffId, date, session: dto.session, status: rec.status,
            source: AttendanceSource.ADMIN, markedById: user.userId, note: dto.note,
          },
        });
        succeeded++;
        continue;
      }
      if (existing.status === rec.status) {
        succeeded++; // idempotent resubmit
        continue;
      }
      await this.db.staffAttendance.update({
        where: { id: existing.id },
        data: { status: rec.status, source: AttendanceSource.ADMIN, markedById: user.userId, note: dto.note },
      });
      // Two different acts, both audited — and until G5 only the first was.
      //
      //  1. Overriding what somebody said about THEMSELVES. Audited with the previous value,
      //     because after the update the row no longer remembers what it claimed.
      //  2. Editing a month that is already CLOSED. There is deliberately no backfill floor on
      //     staff attendance — a school genuinely corrects last month's register, and blocking
      //     that would be worse than the risk. But an admin changing another admin's row from
      //     eight months ago left **no trace at all**, and staff attendance feeds payroll. The
      //     time limit was never the hole; the silence was.
      const overrodeAPerson = existing.source !== AttendanceSource.ADMIN;
      const backdated = isPastMonth(date);
      if (overrodeAPerson || backdated) {
        await this.audit.record({
          action: overrodeAPerson ? AuditActions.STAFF_ATTENDANCE_OVERRIDDEN : AuditActions.STAFF_ATTENDANCE_BACKDATED,
          entityType: 'StaffAttendance',
          entityId: existing.id,
          oldValue: { status: existing.status, source: existing.source, checkIn: existing.checkIn },
          newValue: { status: rec.status, source: AttendanceSource.ADMIN, date: dto.date, backdated },
          reason: dto.note,
        });
      }
      succeeded++;
    }
    return { succeeded, failed: errors.length, errors, absenceQueued: 0 };
  }

  /**
   * Campuses whose payroll for this month is already APPROVED, so their attendance is frozen.
   *
   * **Per campus, not per school.** `PayrollRun` is unique on `[schoolId, campusId, month,
   * year]` — one run per campus — so a school that approves campus A on the 25th must not lose
   * the ability to record attendance in campuses B and C for the rest of the month. One query,
   * because a bulk register can carry staff from several campuses.
   *
   * A staff member with no campus belongs to no payroll run and is therefore never frozen.
   */
  private async frozenCampusIds(date: Date): Promise<Set<string>> {
    const runs = await this.db.payrollRun.findMany({
      where: { month: date.getUTCMonth() + 1, year: date.getUTCFullYear(), status: 'APPROVED' },
      select: { campusId: true },
    });
    return new Set(runs.map((r) => r.campusId));
  }

  private payrollFrozenMessage(date: Date): string {
    return `Payroll for ${date.getUTCMonth() + 1}/${date.getUTCFullYear()} is already approved for this campus — reverse the payroll run before changing attendance for that month.`;
  }

  /** Single-person variant (self check-in): the caller's own campus only. */
  private async assertPayrollOpen(date: Date, campusId: string | null): Promise<void> {
    if (!campusId) return;
    const frozen = await this.frozenCampusIds(date);
    if (frozen.has(campusId)) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, this.payrollFrozenMessage(date));
    }
  }

  /**
   * A staff member marks themselves present, for today, once.
   *
   * The narrow shape IS the security model. `staff_attendance` feeds the payroll deduction, so
   * a teacher who could mark themselves absent (or un-absent, or absent last Tuesday) would be
   * setting their own pay. Hence: presence only, today only, status from the clock rather than
   * from the request, and nothing about anybody else — the endpoint takes no `staffId` at all,
   * so marking a colleague is not a permission that can be misconfigured, it is unexpressible.
   *
   * What this proves is that someone holding this login pressed a button at 07:58 — not that
   * they were on the premises. That is the honest ceiling without hardware, which is why the
   * row is timestamped, attributed, and overridable by the office.
   */
  async checkIn() {
    const schoolId = this.ctx.requireSchoolId();
    const user = this.ctx.user!;
    const staff = await this.selfStaff();

    const school = await this.db.school.findFirst({ where: { id: schoolId } });
    const settings = parseSchoolSettings(school?.settings ?? {});
    if (!settings.staffAttendance.selfMarking) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Self check-in is switched off for this school');
    }

    const now = new Date();
    const date = new Date(new Date().toISOString().slice(0, 10));
    if (startOfDay(staff.joinedAt) > startOfDay(date) || (staff.leftAt && startOfDay(staff.leftAt) < startOfDay(date))) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'You are not employed on this date');
    }
    const campusId = staff.user.campusId;
    const closed = campusId ? await this.nonWorkingReason(date, campusId, settings.weeklyOffDays) : null;
    if (closed) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        HttpStatus.UNPROCESSABLE_ENTITY,
        closed.kind === 'HOLIDAY'
          ? `School is closed today — ${closed.name}. No attendance is taken.`
          : 'Today is a weekly off — no attendance is taken.',
      );
    }
    await this.assertPayrollOpen(date, campusId);

    const session = settings.attendanceSessions[0];
    const existing = await this.db.staffAttendance.findFirst({ where: { staffId: staff.id, date, session } });
    if (existing) {
      // Not an error to retry-proof away: check-in is a claim about a moment, and a second
      // press must never overwrite the first timestamp or silently upgrade an office-recorded
      // ABSENT back to PRESENT.
      //
      // Say WHO decided, though. A row the day-close job wrote is not something this person did,
      // and "You are already marked ABSENT today." reads as an accusation for someone who simply
      // arrived after the register was settled — with no hint that the fix is a word with the
      // office rather than another press of the button.
      const machineWrote = existing.source === AttendanceSource.SYSTEM;
      throw new AppError(
        ErrorCodes.CONFLICT,
        HttpStatus.CONFLICT,
        machineWrote
          ? `The register was closed for today at ${settings.staffAttendance.closeAtTime} and you were recorded ${existing.status}. Ask the office to correct it.`
          : `You are already marked ${existing.status} today.`,
      );
    }

    const status = checkInStatus(now, settings.staffAttendance.dayStartTime, settings.staffAttendance.graceMinutes, settings.timezone);
    const row = await this.db.staffAttendance.create({
      data: {
        schoolId, staffId: staff.id, date, session, status,
        checkIn: now, source: AttendanceSource.SELF, markedById: user.userId,
      },
      select: { date: true, session: true, status: true, checkIn: true },
    });
    return { ...row, dayStartTime: settings.staffAttendance.dayStartTime };
  }

  /** Whether the caller may check in right now, and why not — so the UI states the rule before
   *  the click instead of springing an error after it. */
  async myCheckInState() {
    const schoolId = this.ctx.requireSchoolId();
    const staff = await this.selfStaff();
    const school = await this.db.school.findFirst({ where: { id: schoolId } });
    const settings = parseSchoolSettings(school?.settings ?? {});
    const now = new Date();
    const date = new Date(now.toISOString().slice(0, 10));

    const enabled = settings.staffAttendance.selfMarking;
    const campusId = staff.user.campusId;
    const closedReason = campusId ? await this.nonWorkingReason(date, campusId, settings.weeklyOffDays) : null;
    const nonWorking = closedReason !== null;
    const today = await this.db.staffAttendance.findFirst({
      where: { staffId: staff.id, date, session: settings.attendanceSessions[0] },
      select: { status: true, checkIn: true, source: true },
    });
    return {
      enabled,
      nonWorkingDay: nonWorking,
      /** Named, so /my-attendance can say WHY the button is refusing rather than just that it is. */
      closedFor: closedReason?.kind === 'HOLIDAY' ? closedReason.name : null,
      today,
      /** What pressing the button would record right now — LATE is announced, never sprung. */
      wouldBe: checkInStatus(now, settings.staffAttendance.dayStartTime, settings.staffAttendance.graceMinutes, settings.timezone),
      dayStartTime: settings.staffAttendance.dayStartTime,
      /** When the register is settled, so the screen can say "check in before 20:00" rather than
       *  letting someone discover the deadline by missing it. Only meaningful where the school
       *  actually runs the day-close job. */
      closeAtTime: settings.staffAttendance.autoMarkAbsent ? settings.staffAttendance.closeAtTime : null,
    };
  }

  /**
   * A staff member's own attendance history (self-service), over a date range.
   *
   * Resolves the caller's StaffProfile from their user — no id from the client — so it can
   * only ever return the logged-in person's records (§22.8). Previously a hard `take: 60`,
   * which silently truncated: "how many days was I absent this year?" was unanswerable, and a
   * percentage over an arbitrary last-60-rows window is not a fact about any period.
   */
  async myStaffAttendance(from?: string, to?: string) {
    const staff = await this.selfStaff();
    const range = this.resolveRange(from, to);
    return this.db.staffAttendance.findMany({
      where: { staffId: staff.id, date: { gte: range.from, lte: range.to } },
      orderBy: [{ date: 'desc' }],
      select: { date: true, session: true, status: true, checkIn: true, checkOut: true, source: true },
    });
  }

  /** Counts for the caller's own range — including how many working days nobody marked. */
  async myStaffAttendanceSummary(from?: string, to?: string) {
    const schoolId = this.ctx.requireSchoolId();
    const staff = await this.selfStaff();
    const range = this.resolveRange(from, to);
    const rows = await this.db.staffAttendance.findMany({
      where: { staffId: staff.id, date: { gte: range.from, lte: range.to } },
      select: { status: true },
    });
    const school = await this.db.school.findFirst({ where: { id: schoolId } });
    const settings = parseSchoolSettings(school?.settings ?? {});

    // Bound the window by employment: days before someone joined are not days they missed.
    const start = new Date(Math.max(range.from.getTime(), startOfDay(staff.joinedAt)));
    const end = new Date(Math.min(range.to.getTime(), staff.leftAt ? startOfDay(staff.leftAt) : range.to.getTime()));
    let working = 0;
    if (start.getTime() <= end.getTime()) {
      const holidays = await this.db.holiday.findMany({
        where: { date: { gte: start, lte: end }, OR: [{ campusId: staff.user.campusId }, { campusId: null }] },
        select: { date: true },
      });
      working = workingDaysBetween(
        start, end, settings.weeklyOffDays,
        holidays.map((h) => h.date.toISOString().slice(0, 10)),
      ).length;
    }

    const count = (s: AttendanceStatus) => rows.filter((r) => r.status === s).length;
    const marked = rows.length;
    return {
      from: range.from.toISOString().slice(0, 10),
      to: range.to.toISOString().slice(0, 10),
      present: count(AttendanceStatus.PRESENT),
      late: count(AttendanceStatus.LATE),
      halfDay: count(AttendanceStatus.HALF_DAY),
      onLeave: count(AttendanceStatus.ON_LEAVE),
      absent: count(AttendanceStatus.ABSENT),
      marked,
      workingDays: working,
      /** Working days with no record at all. Not the same as absent, and never folded into it. */
      unmarked: Math.max(0, working - marked),
      percent: attendancePercentFromStatuses(rows.map((r) => r.status)),
    };
  }

  // ── Oversight (owner / campus admin / HR read-only) ──────────────────────────
  /**
   * The staff register for one day: how many people, and what is known about each of them.
   *
   * **`unmarked` is returned separately from `absent` and must stay that way.** Nothing writes
   * an ABSENT row on its own (the day-close job is deliberately deferred), so an absent count
   * presented alone would be a number that looks like fact and is not — it would read as "3
   * absences" when what happened is "39 people nobody recorded". The dashboard leads with the
   * gap for exactly that reason.
   */
  async staffDaySummary(dateStr?: string, campusId?: string) {
    const schoolId = this.ctx.requireSchoolId();
    const date = dateStr ? new Date(dateStr) : new Date(new Date().toISOString().slice(0, 10));
    const campusFilter = this.staffCampusFilter(campusId);

    const school = await this.db.school.findFirst({ where: { id: schoolId } });
    const settings = parseSchoolSettings(school?.settings ?? {});

    const staff = await this.db.staffProfile.findMany({
      where: { user: { deletedAt: null, ...campusFilter }, joinedAt: { lte: date } },
      select: { id: true, leftAt: true },
    });
    const active = staff.filter((s) => !s.leftAt || startOfDay(s.leftAt) >= startOfDay(date));

    const rows = active.length
      ? await this.db.staffAttendance.findMany({
          where: { date, staffId: { in: active.map((s) => s.id) } },
          select: { status: true, source: true },
        })
      : [];

    // Whether the day is a working one is a per-campus question (holidays can be campus-
    // specific). With no campus filter we answer for the school's default calendar.
    const holiday = await this.db.holiday.findFirst({
      where: { date, ...(campusId ? { OR: [{ campusId }, { campusId: null }] } : {}) },
      select: { name: true },
    });
    const weeklyOff = settings.weeklyOffDays.includes(WEEKDAYS[date.getUTCDay()]);

    const count = (s: AttendanceStatus) => rows.filter((r) => r.status === s).length;
    return {
      date: date.toISOString().slice(0, 10),
      workingDay: !weeklyOff && !holiday,
      holidayName: holiday?.name ?? null,
      totalStaff: active.length,
      present: count(AttendanceStatus.PRESENT),
      late: count(AttendanceStatus.LATE),
      halfDay: count(AttendanceStatus.HALF_DAY),
      onLeave: count(AttendanceStatus.ON_LEAVE),
      absent: count(AttendanceStatus.ABSENT),
      /** Nobody recorded anything. NOT absence — see the note above. */
      unmarked: Math.max(0, active.length - rows.length),
      selfMarked: rows.filter((r) => r.source === AttendanceSource.SELF).length,
    };
  }

  /**
   * Every staff member for one day with their status — including those with **no record**,
   * which a query over `staff_attendance` alone could never return. Filtering by `UNMARKED`
   * is what turns this from a report into the worklist that gets the register filled in.
   */
  async staffRegister(dateStr?: string, status?: string, campusId?: string) {
    const date = dateStr ? new Date(dateStr) : new Date(new Date().toISOString().slice(0, 10));
    const campusFilter = this.staffCampusFilter(campusId);

    const staff = await this.db.staffProfile.findMany({
      where: { user: { deletedAt: null, ...campusFilter }, joinedAt: { lte: date } },
      select: {
        id: true, fullName: true, employeeCode: true, staffType: true, leftAt: true,
        user: { select: { email: true, campus: { select: { name: true } } } },
      },
      orderBy: { employeeCode: 'asc' },
    });
    const active = staff.filter((s) => !s.leftAt || startOfDay(s.leftAt) >= startOfDay(date));

    const records = active.length
      ? await this.db.staffAttendance.findMany({
          where: { date, staffId: { in: active.map((s) => s.id) } },
          select: { id: true, staffId: true, status: true, checkIn: true, source: true, note: true },
        })
      : [];
    const byStaff = new Map(records.map((r) => [r.staffId, r]));

    const merged = active.map((s) => {
      const rec = byStaff.get(s.id);
      return {
        staffId: s.id,
        name: s.fullName ?? s.user.email,
        employeeCode: s.employeeCode,
        staffType: s.staffType,
        campus: s.user.campus?.name ?? null,
        // `null` status is the honest rendering of "nobody has said", and it is why this
        // endpoint starts from the staff list rather than from the attendance table.
        status: rec?.status ?? null,
        checkIn: rec?.checkIn ?? null,
        source: rec?.source ?? null,
        note: rec?.note ?? null,
      };
    });
    if (!status) return merged;
    if (status === 'UNMARKED') return merged.filter((r) => r.status === null);
    return merged.filter((r) => r.status === status);
  }

  /** One person's history over a range, with the same counts their own screen shows. */
  async staffHistory(staffId: string, from?: string, to?: string) {
    const staff = await this.db.staffProfile.findFirst({
      where: { id: staffId },
      select: {
        id: true, fullName: true, employeeCode: true, staffType: true, joinedAt: true, leftAt: true,
        user: { select: { email: true, campusId: true, campus: { select: { name: true } } } },
      },
    });
    if (!staff) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Staff member not found');
    // Campus scoping for staff is the USER's campus — the same rule `getStaff` applies, so
    // there is one answer per entity rather than a second one invented here.
    assertCampusAccess(this.ctx.user, staff.user.campusId);

    // "All time" is a real option on this screen, so an absent `from` means from the day they
    // joined — not an invented epoch, and not a silently truncated window.
    const end = to ? new Date(to) : new Date(new Date().toISOString().slice(0, 10));
    const start = from ? new Date(from) : new Date(startOfDay(staff.joinedAt));
    if (start.getTime() > end.getTime()) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, '`from` is after `to`');
    }

    const rows = await this.db.staffAttendance.findMany({
      where: { staffId, date: { gte: start, lte: end } },
      orderBy: [{ date: 'desc' }],
      select: { id: true, date: true, status: true, checkIn: true, source: true, note: true },
    });
    const count = (s: AttendanceStatus) => rows.filter((r) => r.status === s).length;
    return {
      staff: {
        id: staff.id,
        name: staff.fullName ?? staff.user.email,
        employeeCode: staff.employeeCode,
        staffType: staff.staffType,
        campus: staff.user.campus?.name ?? null,
        joinedAt: staff.joinedAt.toISOString().slice(0, 10),
      },
      from: start.toISOString().slice(0, 10),
      to: end.toISOString().slice(0, 10),
      present: count(AttendanceStatus.PRESENT),
      late: count(AttendanceStatus.LATE),
      onLeave: count(AttendanceStatus.ON_LEAVE),
      absent: count(AttendanceStatus.ABSENT),
      percent: attendancePercentFromStatuses(rows.map((r) => r.status)),
      rows: rows.map((r) => ({ ...r, date: r.date.toISOString().slice(0, 10) })),
    };
  }

  /**
   * Campus filter for staff reads. A campus-bound caller is forced to their own campus and a
   * client-supplied `campusId` for another campus is ignored rather than honoured (P1.7).
   */
  private staffCampusFilter(campusId?: string) {
    const restricted = restrictedCampusId(this.ctx.user);
    if (restricted) return { campusId: restricted };
    return campusId ? { campusId } : {};
  }

  /** The caller's own StaffProfile. 403s if the account has no staff record. */
  private async selfStaff() {
    const userId = this.ctx.user?.userId;
    const staff = userId
      ? await this.db.staffProfile.findFirst({
          where: { userId },
          select: { id: true, joinedAt: true, leftAt: true, user: { select: { campusId: true } } },
        })
      : null;
    if (!staff) throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'No staff profile is linked to this account');
    return staff;
  }

  /** Default window is the last 90 days — the screen's opening view, not all history. */
  private resolveRange(from?: string, to?: string) {
    const end = to ? new Date(to) : new Date(new Date().toISOString().slice(0, 10));
    const start = from ? new Date(from) : new Date(end.getTime() - 90 * 86400000);
    if (start.getTime() > end.getTime()) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, '`from` is after `to`');
    }
    return { from: start, to: end };
  }

  // ── helpers ──────────────────────────────────────────────────────────────────
  private async assertCanMark(sectionId: string, user: RequestUser, date: Date): Promise<void> {
    if (isAdmin(user)) return;
    if (!user.roles.includes('TEACHER')) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Not permitted to mark attendance');
    }
    const staff = await this.db.staffProfile.findFirst({ where: { userId: user.userId } });
    if (!staff) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'You are not assigned to this section');
    }
    const yearId = await this.setup.requireCurrentYearId();
    const assignment = await this.db.teacherAssignment.findFirst({
      where: { staffId: staff.id, academicYearId: yearId, sectionId },
    });
    if (assignment) return;

    /**
     * Second way to qualify: **cover** (Cover Plan, C0).
     *
     * Until this existed, a substitute physically standing in front of the class was refused — the
     * register could only be closed by an admin, so someone had to walk to the office while thirty
     * children waited. Cover is deliberately the narrowest possible grant: **this section, on this
     * date**, and attendance only — never exam marks, which are subject-scoped and belong to
     * whoever teaches the subject across a term.
     *
     * `date` is the date being MARKED, not today: backfilling yesterday's register is only allowed
     * to someone who covered it yesterday.
     */
    if (await this.cover.coversSectionOn(staff.id, sectionId, date)) return;

    throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'You are not assigned to this section');
  }

  /**
   * Is the school shut today or tomorrow? — what the app shell asks on every page (H2).
   *
   * **Every authenticated role**, because the audience is the point: teachers have no dashboard
   * (`/dashboard` is owner/campus-admin/accountant only — a teacher lands on `/attendance`), so a
   * notice hung on a dashboard would miss exactly the people who need to know the gate is locked.
   * The shell wraps every page for every role, so one call reaches all of them.
   *
   * **Only today and tomorrow.** A closure three weeks out belongs on the calendar; a banner that
   * is always there stops being read, which is the failure mode that makes the banner worthless
   * on the day it matters.
   *
   * Weekly offs are deliberately NOT returned. Everybody already knows the school is shut on
   * Sunday; announcing it every week is how a notice becomes wallpaper.
   */
  async closureNotice() {
    const schoolId = this.ctx.requireSchoolId();
    const school = await this.db.school.findFirst({ where: { id: schoolId }, select: { settings: true } });
    const settings = parseSchoolSettings(school?.settings ?? {});

    // The school's own clock (G4) — "today" for a school in another zone is not the server's.
    const now = new Date();
    const localToday = new Date(
      new Intl.DateTimeFormat('en-CA', { timeZone: settings.timezone }).format(now),
    );
    const localTomorrow = new Date(localToday.getTime() + 86400000);

    // A teacher/staff member is bound to their campus; a student is not campus-bound in the
    // session, so they see school-wide closures plus their own campus's via the enrolment.
    const campusId = this.ctx.user?.campusId ?? null;
    const holidays = await this.db.holiday.findMany({
      where: {
        date: { in: [localToday, localTomorrow] },
        ...(campusId ? { OR: [{ campusId }, { campusId: null }] } : {}),
      },
      orderBy: { date: 'asc' },
      select: { date: true, name: true },
    });
    if (!holidays.length) return { closure: null };

    const first = holidays[0];
    const isToday = first.date.getTime() === localToday.getTime();
    return {
      closure: {
        date: first.date.toISOString().slice(0, 10),
        name: first.name,
        when: isToday ? ('TODAY' as const) : ('TOMORROW' as const),
      },
    };
  }

  /**
   * WHY a day is not a working one — not merely whether (H2).
   *
   * This returned a boolean, so every screen downstream could only say "holiday or weekly off",
   * which reads as *the button is broken* rather than *the school is shut*. The `holidayName`
   * the dashboard has always rendered was fed by nothing, because nothing carried the name this
   * far. A refusal that cannot say why is a refusal the reader argues with.
   *
   * Weekly off wins the tie: if a school is closed on Sundays and someone also records Eid on a
   * Sunday, "weekly off" is the truer answer and avoids a closure that looks like it did work.
   */
  private async nonWorkingReason(
    date: Date,
    campusId: string,
    weeklyOff: string[],
  ): Promise<{ kind: 'WEEKLY_OFF' } | { kind: 'HOLIDAY'; name: string } | null> {
    if (weeklyOff.includes(WEEKDAYS[date.getUTCDay()])) return { kind: 'WEEKLY_OFF' };
    const holiday = await this.db.holiday.findFirst({
      where: { date, OR: [{ campusId }, { campusId: null }] },
      select: { name: true },
    });
    return holiday ? { kind: 'HOLIDAY', name: holiday.name } : null;
  }

  /** Boolean shorthand for the callers that only branch on it. */
  private async isNonWorkingDay(date: Date, campusId: string, weeklyOff: string[]): Promise<boolean> {
    return (await this.nonWorkingReason(date, campusId, weeklyOff)) !== null;
  }
}

function isAdmin(user: RequestUser): boolean {
  return user.roles.includes('OWNER_ADMIN') || user.roles.includes('CAMPUS_ADMIN');
}
/**
 * Is this date in a month that has already closed? (G5)
 *
 * Deliberately coarse — the MONTH, not "more than N days ago" — because payroll is monthly. An
 * edit inside the current month is ordinary register-keeping; one reaching back into a month the
 * office has already worked through is the act worth recording.
 */
function isPastMonth(d: Date): boolean {
  const now = new Date();
  return d.getUTCFullYear() < now.getUTCFullYear()
    || (d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() < now.getUTCMonth());
}

function startOfDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function daysSince(date: Date): number {
  return Math.floor((startOfDay(new Date()) - startOfDay(date)) / 86400000);
}
