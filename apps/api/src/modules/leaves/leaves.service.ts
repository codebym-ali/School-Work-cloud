import { HttpStatus, Injectable } from '@nestjs/common';
import { AttendanceStatus, LeaveStatus, StaffLeaveType } from '@prisma/client';
import {
  AppError,
  ErrorCodes,
  isAdminRole,
  paginate,
  parseSchoolSettings,
  TenantContext,
  toSkipTake,
  type Paginated,
} from '@common';
import { TenantPrismaService } from '@database';
import { SmsProducer } from '../comms/sms/sms-producer.service';
import type {
  CreateStaffLeaveDto,
  CreateStudentLeaveDto,
  LeaveListQuery,
  RejectLeaveDto,
} from './dto/leaves.dto';

/**
 * Leave management (blueprint §10). Machine: PENDING -> APPROVED | REJECTED
 * (terminal); CANCELLED by the requester while PENDING. New leaves overlapping an
 * existing PENDING/APPROVED leave for the same person => 409 LEAVE_OVERLAP.
 * Approving a student leave writes ON_LEAVE attendance across the range and locks
 * those cells against teacher edits (§9).
 */
@Injectable()
export class LeavesService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly sms: SmsProducer,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }
  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  // ── Student leaves ─────────────────────────────────────────────────────────
  async createStudentLeave(dto: CreateStudentLeaveDto) {
    // GuardianOfStudent (§22.8, P1.7): a PARENT may only file leave for their own child;
    // admins and teachers act on behalf of students in their scope.
    const user = this.ctx.user!;
    if (!isAdminRole(user) && !user.roles.includes('TEACHER')) {
      const link = await this.db.studentGuardian.findFirst({ where: { studentId: dto.studentId, parent: { userId: user.userId } } });
      if (!link) throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Not a guardian of this student');
    }
    const from = new Date(dto.fromDate);
    const to = new Date(dto.toDate);
    if (to < from) throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'toDate before fromDate');
    const overlap = await this.db.studentLeave.findFirst({
      where: {
        studentId: dto.studentId,
        status: { in: [LeaveStatus.PENDING, LeaveStatus.APPROVED] },
        fromDate: { lte: to },
        toDate: { gte: from },
      },
    });
    if (overlap) throw new AppError(ErrorCodes.LEAVE_OVERLAP, HttpStatus.CONFLICT, 'Overlaps an existing leave');
    return this.db.studentLeave.create({
      data: {
        schoolId: this.sid,
        studentId: dto.studentId,
        fromDate: from,
        toDate: to,
        reason: dto.reason,
        status: LeaveStatus.PENDING,
        requestedById: this.ctx.user!.userId,
      },
    });
  }

  async approveStudentLeave(id: string) {
    const leave = await this.getStudentLeave(id);
    this.assertPending(leave.status);
    const updated = await this.db.studentLeave.update({
      where: { id },
      data: { status: LeaveStatus.APPROVED, decidedById: this.ctx.user!.userId, decidedAt: new Date() },
    });
    await this.writeOnLeaveAttendance(leave.studentId, leave.fromDate, leave.toDate, id);
    await this.sms.enqueueLeaveStatus({ type: 'LEAVE_STATUS', schoolId: this.sid, studentId: leave.studentId, status: 'APPROVED' });
    return updated;
  }

  async rejectStudentLeave(id: string, dto: RejectLeaveDto) {
    const leave = await this.getStudentLeave(id);
    this.assertPending(leave.status);
    const updated = await this.db.studentLeave.update({
      where: { id },
      data: { status: LeaveStatus.REJECTED, rejectionReason: dto.reason, decidedById: this.ctx.user!.userId, decidedAt: new Date() },
    });
    await this.sms.enqueueLeaveStatus({ type: 'LEAVE_STATUS', schoolId: this.sid, studentId: leave.studentId, status: 'REJECTED' });
    return updated;
  }

  async cancelStudentLeave(id: string) {
    const leave = await this.getStudentLeave(id);
    this.assertPending(leave.status);
    if (leave.requestedById !== this.ctx.user!.userId) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Only the requester can cancel');
    }
    return this.db.studentLeave.update({ where: { id }, data: { status: LeaveStatus.CANCELLED } });
  }

  async listStudentLeaves(q: LeaveListQuery): Promise<Paginated<unknown>> {
    // A PARENT sees only their own children's leaves (force-scoped, deny-by-default).
    const user = this.ctx.user!;
    const parentScope = !isAdminRole(user) && !user.roles.includes('TEACHER');
    const where = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.studentId ? { studentId: q.studentId } : {}),
      ...(parentScope ? { student: { guardians: { some: { parent: { userId: user.userId } } } } } : {}),
    };
    const { skip, take } = toSkipTake(q);
    const [rows, total] = await Promise.all([
      this.db.studentLeave.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.db.studentLeave.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  // ── Staff leaves ───────────────────────────────────────────────────────────
  async createStaffLeave(dto: CreateStaffLeaveDto) {
    const from = new Date(dto.fromDate);
    const to = new Date(dto.toDate);
    if (to < from) throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'toDate before fromDate');
    const overlap = await this.db.staffLeave.findFirst({
      where: {
        staffId: dto.staffId,
        status: { in: [LeaveStatus.PENDING, LeaveStatus.APPROVED] },
        fromDate: { lte: to },
        toDate: { gte: from },
      },
    });
    if (overlap) throw new AppError(ErrorCodes.LEAVE_OVERLAP, HttpStatus.CONFLICT, 'Overlaps an existing leave');

    // Quota: exceeding the annual per-type quota auto-flags the request UNPAID (§10).
    const isUnpaid = await this.exceedsQuota(dto.staffId, dto.leaveType);
    return this.db.staffLeave.create({
      data: {
        schoolId: this.sid,
        staffId: dto.staffId,
        leaveType: dto.leaveType,
        fromDate: from,
        toDate: to,
        reason: dto.reason,
        status: LeaveStatus.PENDING,
        isUnpaid,
      },
    });
  }

  async approveStaffLeave(id: string) {
    const leave = await this.getStaffLeave(id);
    this.assertPending(leave.status);
    return this.db.staffLeave.update({
      where: { id },
      data: { status: LeaveStatus.APPROVED, decidedById: this.ctx.user!.userId, decidedAt: new Date() },
    });
  }

  async rejectStaffLeave(id: string, dto: RejectLeaveDto) {
    const leave = await this.getStaffLeave(id);
    this.assertPending(leave.status);
    return this.db.staffLeave.update({
      where: { id },
      data: { status: LeaveStatus.REJECTED, rejectionReason: dto.reason, decidedById: this.ctx.user!.userId, decidedAt: new Date() },
    });
  }

  async cancelStaffLeave(id: string) {
    const leave = await this.getStaffLeave(id);
    this.assertPending(leave.status);
    return this.db.staffLeave.update({ where: { id }, data: { status: LeaveStatus.CANCELLED } });
  }

  async listStaffLeaves(q: LeaveListQuery): Promise<Paginated<unknown>> {
    const where = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.staffId ? { staffId: q.staffId } : {}),
    };
    const { skip, take } = toSkipTake(q);
    const [rows, total] = await Promise.all([
      this.db.staffLeave.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.db.staffLeave.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  // ── helpers ──────────────────────────────────────────────────────────────────
  private assertPending(status: LeaveStatus): void {
    if (status !== LeaveStatus.PENDING) {
      throw new AppError(ErrorCodes.INVALID_STATE_TRANSITION, HttpStatus.CONFLICT, `Leave is ${status}, not PENDING`);
    }
  }

  private async getStudentLeave(id: string) {
    const l = await this.db.studentLeave.findFirst({ where: { id } });
    if (!l) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Leave not found');
    return l;
  }
  private async getStaffLeave(id: string) {
    const l = await this.db.staffLeave.findFirst({ where: { id } });
    if (!l) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Leave not found');
    return l;
  }

  private async exceedsQuota(staffId: string, type: StaffLeaveType): Promise<boolean> {
    const school = await this.db.school.findFirst({ where: { id: this.sid } });
    const quotas = parseSchoolSettings(school?.settings ?? {}).staffLeaveQuotas as Record<string, number>;
    const quota = quotas?.[type];
    if (quota == null) return false;
    const used = await this.db.staffLeave.count({
      where: { staffId, leaveType: type, status: LeaveStatus.APPROVED, isUnpaid: false },
    });
    return used >= quota;
  }

  /** Overwrite ON_LEAVE + lock for every (date, session) in the leave range (§9). */
  private async writeOnLeaveAttendance(studentId: string, from: Date, to: Date, leaveId: string): Promise<void> {
    const enrollment = await this.db.studentEnrollment.findFirst({ where: { studentId, status: 'ACTIVE' } });
    if (!enrollment) return;
    const school = await this.db.school.findFirst({ where: { id: this.sid } });
    const sessions = parseSchoolSettings(school?.settings ?? {}).attendanceSessions;

    for (let d = new Date(from); d <= to; d = new Date(d.getTime() + 86400000)) {
      const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      for (const session of sessions) {
        const existing = await this.db.attendanceRecord.findFirst({ where: { enrollmentId: enrollment.id, date, session } });
        if (existing) {
          await this.db.attendanceRecord.update({
            where: { id: existing.id },
            data: { status: AttendanceStatus.ON_LEAVE, lockedByLeaveId: leaveId, markedById: this.ctx.user!.userId },
          });
        } else {
          await this.db.attendanceRecord.create({
            data: {
              schoolId: this.sid,
              enrollmentId: enrollment.id,
              date,
              session,
              status: AttendanceStatus.ON_LEAVE,
              lockedByLeaveId: leaveId,
              markedById: this.ctx.user!.userId,
            },
          });
        }
      }
    }
  }
}
