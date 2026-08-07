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
  workingDaysBetween,
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
    // Deny-by-default for anyone who is not an admin or teacher (§22.8, P1.7). This outlived
    // the parent portal on purpose: it is the only thing standing between a non-admin caller
    // and another student's record, so it must NOT be removed as "parent code".
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
    // GET /student-leaves has NO @Roles, so any authenticated caller reaches it — this filter
    // is what stops a non-admin (e.g. a STUDENT) seeing every leave in the school. Kept
    // deliberately after the parent portal was removed; it now denies rather than scopes.
    const user = this.ctx.user!;
    const parentScope = !isAdminRole(user) && !user.roles.includes('TEACHER');
    const where = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.studentId ? { studentId: q.studentId } : {}),
      ...(parentScope ? { student: { guardians: { some: { parent: { userId: user.userId } } } } } : {}),
    };
    const { skip, take } = toSkipTake(q);
    const [rows, total] = await Promise.all([
      // The approving admin needs to know WHOSE leave this is — a queue of UUIDs is unusable.
      this.db.studentLeave.findMany({
        where, skip, take, orderBy: { createdAt: 'desc' },
        include: { student: { select: { fullName: true, grNumber: true } } },
      }),
      this.db.studentLeave.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  // ── Staff leaves ───────────────────────────────────────────────────────────
  async createStaffLeave(dto: CreateStaffLeaveDto) {
    // §22.8: staff/teachers file only their OWN leave (staffId resolved from the caller,
    // never trusted from the body). An admin may file on someone's behalf via dto.staffId.
    const staffId = await this.resolveStaffId(dto.staffId);
    const from = new Date(dto.fromDate);
    const to = new Date(dto.toDate);
    if (to < from) throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'toDate before fromDate');
    const overlap = await this.db.staffLeave.findFirst({
      where: {
        staffId,
        status: { in: [LeaveStatus.PENDING, LeaveStatus.APPROVED] },
        fromDate: { lte: to },
        toDate: { gte: from },
      },
    });
    if (overlap) throw new AppError(ErrorCodes.LEAVE_OVERLAP, HttpStatus.CONFLICT, 'Overlaps an existing leave');

    // Provisional: the applicant is told up front whether this will be paid. Re-decided at
    // approve, which is the moment it becomes real — see `decideUnpaid`.
    const isUnpaid = await this.decideUnpaid(staffId, dto.leaveType, from, to);
    return this.db.staffLeave.create({
      data: {
        schoolId: this.sid,
        staffId,
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
    // Re-decided here rather than trusted from create time. Entitlement is consumed in APPROVAL
    // order, so a request filed first but approved second gets what is actually left — and a
    // request stamped months ago cannot carry a stale answer into someone's salary.
    const isUnpaid = await this.decideUnpaid(leave.staffId, leave.leaveType, leave.fromDate, leave.toDate, id);
    const updated = await this.db.staffLeave.update({
      where: { id },
      data: { status: LeaveStatus.APPROVED, isUnpaid, decidedById: this.ctx.user!.userId, decidedAt: new Date() },
    });
    const settled = await this.settleStaffRegister(leave.staffId, leave.fromDate, leave.toDate);
    return { ...updated, attendanceCorrected: settled };
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
    // §22.8: a non-admin may cancel only their own leave.
    if (!isAdminRole(this.ctx.user) && leave.staffId !== (await this.selfStaffId())) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Only the requester can cancel');
    }
    return this.db.staffLeave.update({ where: { id }, data: { status: LeaveStatus.CANCELLED } });
  }

  async listStaffLeaves(q: LeaveListQuery): Promise<Paginated<unknown>> {
    // A non-admin (staff/teacher) sees only their OWN leaves (force-scoped, deny-by-default);
    // an admin may filter by any staffId.
    const user = this.ctx.user!;
    const scopedStaffId = isAdminRole(user) ? q.staffId : await this.selfStaffId();
    const where = {
      ...(q.status ? { status: q.status } : {}),
      ...(scopedStaffId ? { staffId: scopedStaffId } : {}),
    };
    const { skip, take } = toSkipTake(q);
    const [rows, total] = await Promise.all([
      this.db.staffLeave.findMany({
        where, skip, take, orderBy: { createdAt: 'desc' },
        include: { staff: { select: { fullName: true, employeeCode: true } } },
      }),
      this.db.staffLeave.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  // ── helpers ──────────────────────────────────────────────────────────────────
  /** The StaffProfile id for the calling user, or 403 if the account has none. */
  private async selfStaffId(): Promise<string> {
    const staff = await this.db.staffProfile.findFirst({ where: { userId: this.ctx.user!.userId }, select: { id: true } });
    if (!staff) throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'No staff profile is linked to this account');
    return staff.id;
  }

  /** Whose staff leave to act on: an admin may target `requested`; everyone else is forced to
   *  their own profile regardless of what the body claims. Filing requires an admin to name
   *  somebody (`adminMayOmit` false) — on a read, an admin naming nobody means themselves. */
  private async resolveStaffId(requested?: string, adminMayOmit = false): Promise<string> {
    if (isAdminRole(this.ctx.user)) {
      if (requested) return requested;
      if (!adminMayOmit) throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'staffId is required');
      return this.selfStaffId();
    }
    return this.selfStaffId();
  }

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

  /**
   * The window a quota is measured over: the current academic year (§10 says "annual", and a
   * school's year is the one it runs on, not January–December). Falls back to the calendar year
   * when no year is marked current — an unbounded window would let an entitlement accumulate for
   * ever, which is the bug this replaced.
   */
  private async quotaWindow(): Promise<{ start: Date; end: Date }> {
    const year = await this.db.academicYear.findFirst({
      where: { isCurrent: true },
      select: { startDate: true, endDate: true },
    });
    if (year) return { start: new Date(year.startDate), end: new Date(year.endDate) };
    const y = new Date().getUTCFullYear();
    return { start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y, 11, 31)) };
  }

  /**
   * The days a leave actually costs: weekly offs and declared closures are not leave.
   *
   * A Sunday inside a leave range is not a day off work — it was already a day off. Counting it
   * mattered in two places at once: it consumed entitlement the person never spent, and payroll
   * deducted it at `basic / workingDays`, a rate whose denominator already excludes Sundays. A
   * week's leave over a six-working-day week was charged as seven.
   */
  private async leaveDays(staffId: string, from: Date, to: Date): Promise<number> {
    const settings = parseSchoolSettings((await this.db.school.findFirst({ where: { id: this.sid } }))?.settings ?? {});
    const campusId = (await this.db.staffProfile.findFirst({ where: { id: staffId }, select: { user: { select: { campusId: true } } } }))?.user?.campusId ?? null;
    const holidays = await this.db.holiday.findMany({
      where: { date: { gte: from, lte: to }, ...(campusId ? { OR: [{ campusId }, { campusId: null }] } : { campusId: null }) },
      select: { date: true },
    });
    return workingDaysBetween(
      from, to,
      settings.weeklyOffDays,
      holidays.map((h) => new Date(h.date).toISOString().slice(0, 10)),
    ).length;
  }

  /**
   * What this person's entitlement looks like right now, per type (§10).
   *
   * Exists because the quota used to be invisible: it silently flipped a request to unpaid and
   * the person found out on their payslip. A rule that decides pay has to be readable before it
   * is applied, by both the applicant and whoever approves.
   *
   * `entitlementDays: null` means the school has set no quota for that type — which is **not**
   * zero. Unconfigured types have always been paid without limit, and reading "unset" as "none"
   * would turn every OTHER leave unpaid the day this shipped: a pay cut delivered by an upgrade.
   */
  async staffLeaveBalance(q: { staffId?: string; fromDate?: string; toDate?: string; leaveType?: StaffLeaveType }) {
    const staffId = await this.resolveStaffId(q.staffId, /* adminMayOmit */ true);
    const { start, end } = await this.quotaWindow();
    const quotas = parseSchoolSettings((await this.db.school.findFirst({ where: { id: this.sid } }))?.settings ?? {})
      .staffLeaveQuotas as Record<string, number | undefined>;

    const leaves = await this.db.staffLeave.findMany({
      where: {
        staffId,
        status: { in: [LeaveStatus.APPROVED, LeaveStatus.PENDING] },
        fromDate: { lte: end },
        toDate: { gte: start },
      },
      select: { leaveType: true, status: true, isUnpaid: true, fromDate: true, toDate: true },
    });

    const types = Object.values(StaffLeaveType);
    const rows = [];
    for (const type of types) {
      let used = 0;
      let pending = 0;
      for (const l of leaves.filter((x) => x.leaveType === type)) {
        // Clipped to the window, so a leave straddling the year boundary is not charged twice.
        const days = await this.leaveDays(
          staffId,
          new Date(Math.max(new Date(l.fromDate).getTime(), start.getTime())),
          new Date(Math.min(new Date(l.toDate).getTime(), end.getTime())),
        );
        if (l.status === LeaveStatus.PENDING) pending += days;
        else if (!l.isUnpaid) used += days; // an unpaid leave was never charged to entitlement
      }
      const entitlement = quotas?.[type] ?? null;
      rows.push({
        leaveType: type,
        entitlementDays: entitlement,
        usedDays: used,
        pendingDays: pending,
        remainingDays: entitlement == null ? null : Math.max(0, entitlement - used),
      });
    }
    // Priced by `decideUnpaid` itself, not by a second implementation of the same rule — so what
    // the applicant is warned about and what they are later charged cannot disagree.
    let proposed: { workingDays: number; wouldBeUnpaid: boolean } | null = null;
    if (q.fromDate && q.toDate && q.leaveType) {
      const from = new Date(q.fromDate);
      const to = new Date(q.toDate);
      if (to >= from) {
        proposed = {
          workingDays: await this.leaveDays(staffId, from, to),
          wouldBeUnpaid: await this.decideUnpaid(staffId, q.leaveType, from, to),
        };
      }
    }

    return {
      staffId,
      windowStart: start.toISOString().slice(0, 10),
      windowEnd: end.toISOString().slice(0, 10),
      balances: rows,
      proposed,
    };
  }

  /**
   * Is this leave unpaid? Two ways to be, and they are different things.
   *
   * 1. **Type UNPAID is always unpaid.** It used to be paid: the quota map has no `UNPAID` key,
   *    the lookup returned undefined, and "no quota" short-circuited to paid — so the one leave
   *    type whose name says it reduces pay was the one that did not.
   * 2. **Over entitlement.** Whole-request, not a split: a request that takes the person past
   *    their remaining days is unpaid in full. That is blunt, but it is what the applicant is
   *    shown before submitting, so nobody learns it from a payslip.
   */
  private async decideUnpaid(
    staffId: string,
    type: StaffLeaveType,
    from: Date,
    to: Date,
    excludeLeaveId?: string,
  ): Promise<boolean> {
    if (type === StaffLeaveType.UNPAID) return true;

    const quotas = parseSchoolSettings((await this.db.school.findFirst({ where: { id: this.sid } }))?.settings ?? {})
      .staffLeaveQuotas as Record<string, number | undefined>;
    const entitlement = quotas?.[type];
    if (entitlement == null) return false; // unconfigured = no limit, deliberately (see staffLeaveBalance)

    const { start, end } = await this.quotaWindow();
    // Entitlement is consumed in approval order, so only APPROVED leaves count against it — a
    // pending request that is later rejected must not have quietly spent somebody's days.
    const approved = await this.db.staffLeave.findMany({
      where: {
        staffId, leaveType: type, status: LeaveStatus.APPROVED, isUnpaid: false,
        fromDate: { lte: end }, toDate: { gte: start },
        ...(excludeLeaveId ? { id: { not: excludeLeaveId } } : {}),
      },
      select: { fromDate: true, toDate: true },
    });
    let used = 0;
    for (const l of approved) {
      used += await this.leaveDays(
        staffId,
        new Date(Math.max(new Date(l.fromDate).getTime(), start.getTime())),
        new Date(Math.min(new Date(l.toDate).getTime(), end.getTime())),
      );
    }
    return used + (await this.leaveDays(staffId, from, to)) > entitlement;
  }

  /**
   * Make the staff register agree with the decision that was just taken.
   *
   * Without this, approving changed nothing a payslip could see: a day already marked ABSENT —
   * by the office, or by the day-close job that ran before the leave existed — stayed ABSENT, and
   * `payroll.absentDays()` counts exactly those rows. The commonest case in a real school is the
   * medical certificate that arrives the next morning, and it silently cost the person a day's
   * pay every time.
   *
   * Three refusals, each protecting something:
   *  - **converts, never fabricates** — a day nobody recorded stays unrecorded, because "approved
   *    leave" is not evidence about a day, and marking future days would be marking the future;
   *  - **never overwrites PRESENT / LATE / HALF_DAY** — they came in, and an approval covering a
   *    range that includes a day they worked must not erase the observation;
   *  - **skips a month whose payroll is APPROVED** — a paid payslip must keep agreeing with the
   *    register it was computed from.
   */
  private async settleStaffRegister(staffId: string, from: Date, to: Date): Promise<number> {
    const rows = await this.db.staffAttendance.findMany({
      where: { staffId, date: { gte: from, lte: to }, status: AttendanceStatus.ABSENT },
      select: { id: true, date: true },
    });
    if (!rows.length) return 0;

    const campusId = (await this.db.staffProfile.findFirst({ where: { id: staffId }, select: { user: { select: { campusId: true } } } }))?.user?.campusId ?? null;
    const frozen = new Set(
      (await this.db.payrollRun.findMany({
        where: { status: 'APPROVED', ...(campusId ? { campusId } : {}) },
        select: { month: true, year: true },
      })).map((r) => `${r.year}-${r.month}`),
    );

    let corrected = 0;
    for (const row of rows) {
      const d = new Date(row.date);
      if (frozen.has(`${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`)) continue;
      await this.db.staffAttendance.update({
        where: { id: row.id },
        data: {
          status: AttendanceStatus.ON_LEAVE,
          markedById: this.ctx.user!.userId,
          note: 'Corrected by approved leave',
        },
      });
      corrected++;
    }
    return corrected;
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
