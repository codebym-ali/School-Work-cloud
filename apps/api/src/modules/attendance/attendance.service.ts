import { HttpStatus, Injectable } from '@nestjs/common';
import { AttendanceStatus, type AttendanceSession, type Prisma } from '@prisma/client';
import {
  AppError,
  assertCampusAccess,
  AuditActions,
  ErrorCodes,
  parseSchoolSettings,
  restrictedCampusId,
  TenantContext,
  type RequestUser,
} from '@common';
import { AuditService, TenantPrismaService } from '@database';
import { SetupService } from '../setup/setup.service';
import { SmsProducer } from '../comms/sms/sms-producer.service';
import type {
  AttendanceQuery,
  MarkAttendanceDto,
  MarkStaffAttendanceDto,
  PatchAttendanceDto,
} from './dto/attendance.dto';

const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

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

    const off = await this.isNonWorkingDay(date, section.class.campusId, settings.weeklyOffDays);
    if (off && !dto.allowHolidayOverride) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Holiday/weekly-off day; admin override required');
    }
    if (off && dto.allowHolidayOverride && !isAdmin(user)) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Only an admin may override holiday marking');
    }

    await this.assertCanMark(dto.sectionId, user);
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
        const working = !(await this.isNonWorkingDay(d, section.class.campusId, settings.weeklyOffDays));
        // Expected head-count is per-day: a student who joined on Thursday was never owed a
        // Monday mark, so counting them would leave the day permanently "incomplete".
        const expected = working ? enrolments.filter((e) => startOfDay(e.startedAt) <= startOfDay(d)).length : 0;
        return {
          date: d.toISOString().slice(0, 10),
          working,
          marked: markedBy.get(startOfDay(d)) ?? 0,
          expected,
        };
      }),
    );
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

  // ── Staff attendance (basic) ─────────────────────────────────────────────────
  async markStaffBulk(dto: MarkStaffAttendanceDto): Promise<BulkResult> {
    const schoolId = this.ctx.requireSchoolId();
    const date = new Date(dto.date);
    const errors: BulkResult['errors'] = [];
    let succeeded = 0;
    for (let i = 0; i < dto.records.length; i++) {
      const rec = dto.records[i];
      const existing = await this.db.staffAttendance.findFirst({ where: { staffId: rec.staffId, date, session: dto.session } });
      if (existing) {
        await this.db.staffAttendance.update({ where: { id: existing.id }, data: { status: rec.status } });
      } else {
        await this.db.staffAttendance.create({
          data: { schoolId, staffId: rec.staffId, date, session: dto.session, status: rec.status },
        });
      }
      succeeded++;
    }
    return { succeeded, failed: errors.length, errors, absenceQueued: 0 };
  }

  /**
   * A staff member's own attendance history (self-service). Resolves the caller's
   * StaffProfile from their user — no id from the client — so it can only ever return
   * the logged-in person's records (§22.8). 403s if the account has no staff profile.
   */
  async myStaffAttendance() {
    const userId = this.ctx.user?.userId;
    const staff = userId ? await this.db.staffProfile.findFirst({ where: { userId } }) : null;
    if (!staff) throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'No staff profile is linked to this account');
    return this.db.staffAttendance.findMany({
      where: { staffId: staff.id },
      orderBy: [{ date: 'desc' }],
      take: 60,
      select: { date: true, session: true, status: true, checkIn: true, checkOut: true },
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────────
  private async assertCanMark(sectionId: string, user: RequestUser): Promise<void> {
    if (isAdmin(user)) return;
    if (!user.roles.includes('TEACHER')) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Not permitted to mark attendance');
    }
    const staff = await this.db.staffProfile.findFirst({ where: { userId: user.userId } });
    const yearId = await this.setup.requireCurrentYearId();
    const assignment = staff
      ? await this.db.teacherAssignment.findFirst({ where: { staffId: staff.id, academicYearId: yearId, sectionId } })
      : null;
    if (!assignment) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'You are not assigned to this section');
    }
  }

  private async isNonWorkingDay(date: Date, campusId: string, weeklyOff: string[]): Promise<boolean> {
    if (weeklyOff.includes(WEEKDAYS[date.getUTCDay()])) return true;
    const holiday = await this.db.holiday.findFirst({
      where: { date, OR: [{ campusId }, { campusId: null }] },
    });
    return !!holiday;
  }
}

function isAdmin(user: RequestUser): boolean {
  return user.roles.includes('OWNER_ADMIN') || user.roles.includes('CAMPUS_ADMIN');
}
function startOfDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function daysSince(date: Date): number {
  return Math.floor((startOfDay(new Date()) - startOfDay(date)) / 86400000);
}
