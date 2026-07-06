import { HttpStatus, Injectable } from '@nestjs/common';
import { AttendanceStatus, type Prisma } from '@prisma/client';
import {
  AppError,
  AuditActions,
  ErrorCodes,
  parseSchoolSettings,
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

    const section = await this.db.section.findFirst({
      where: { id: dto.sectionId },
      include: { class: { select: { campusId: true } } },
    });
    if (!section) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Section not found');

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
      const enr = await this.db.studentEnrollment.findFirst({ where: { id: rec.enrollmentId } });
      if (!enr || enr.status !== 'ACTIVE' || enr.sectionId !== dto.sectionId || enr.academicYearId !== currentYearId) {
        errors.push({ index: i, code: ErrorCodes.VALIDATION_FAILED, message: 'Enrollment not ACTIVE in this section/year' });
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

    // Enqueue absence SMS once per newly-ABSENT enrollment (dedup by BullMQ jobId).
    for (const a of newlyAbsent) {
      await this.sms.enqueueAbsence({ type: 'ABSENCE', schoolId, enrollmentId: a.enrollmentId, studentId: a.studentId, date: dto.date });
    }

    return { succeeded, failed: errors.length, errors, absenceQueued: newlyAbsent.length };
  }

  async query(q: AttendanceQuery) {
    const where: Prisma.AttendanceRecordWhereInput = {};
    if (q.date) where.date = new Date(q.date);
    const enroll: Prisma.StudentEnrollmentWhereInput = {};
    if (q.sectionId) enroll.sectionId = q.sectionId;
    if (q.studentId) enroll.studentId = q.studentId;
    if (q.sectionId || q.studentId) where.enrollment = enroll;
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
    const existing = await this.db.attendanceRecord.findFirst({ where: { id } });
    if (!existing) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Attendance record not found');
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
