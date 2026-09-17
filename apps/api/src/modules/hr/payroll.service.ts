import { HttpStatus, Injectable } from '@nestjs/common';
import { AttendanceStatus, LeaveStatus, PayrollRunStatus, Prisma } from '@prisma/client';
import { AppError, assertCampusAccess, AuditActions, effectiveCampusFilter, ErrorCodes, parseSchoolSettings, PdfService, StorageService, TenantContext, workingDaysBetween } from '@common';
import { AuditService, TenantPrismaService } from '@database';
import type { MarkPaidDto, RunPayrollDto } from './dto/hr.dto';

const money = (n: number): number => Math.round(n * 100) / 100;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const sumValues = (o: unknown): number =>
  o && typeof o === 'object' ? Object.values(o as Record<string, number>).reduce((s, v) => s + Number(v), 0) : 0;

/**
 * Payroll (blueprint §13). Per staff: gross = basic + Σ allowances; attendance-linked
 * deduction = (unpaidLeaveDays + absentDays) × (basic / workingDaysInMonth);
 * net = gross − fixedDeductions − attendanceDeduction. Run is DRAFT until OWNER_ADMIN
 * APPROVES it (which locks payslips); disbursement is recorded per payslip.
 */
@Injectable()
export class PayrollService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly pdf: PdfService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }
  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  async run(dto: RunPayrollDto) {
    // A campus accountant drafts their own campus only; the owner, any.
    assertCampusAccess(this.ctx.user, dto.campusId);
    const existing = await this.db.payrollRun.findFirst({ where: { campusId: dto.campusId, month: dto.month, year: dto.year } });
    if (existing) return { runId: existing.id, alreadyExists: true, payslips: 0 };

    const monthStart = new Date(Date.UTC(dto.year, dto.month - 1, 1));
    const monthEnd = new Date(Date.UTC(dto.year, dto.month, 0));
    const settings = parseSchoolSettings((await this.db.school.findFirst({ where: { id: this.sid } }))?.settings ?? {});
    // Resolved once and shared with the leave count below, so the month's divisor and the days
    // charged against it are derived from the same calendar. Two calendars is how a leave day
    // gets deducted at a rate that never counted it.
    const holidayISODates = (await this.db.holiday.findMany({
      where: { date: { gte: monthStart, lte: monthEnd }, OR: [{ campusId: dto.campusId }, { campusId: null }] },
      select: { date: true },
    })).map((h) => new Date(h.date).toISOString().slice(0, 10));
    const workingDays = workingDaysBetween(monthStart, monthEnd, settings.weeklyOffDays, holidayISODates).length;

    let run;
    try {
      run = await this.db.payrollRun.create({
        data: { schoolId: this.sid, campusId: dto.campusId, month: dto.month, year: dto.year, status: PayrollRunStatus.DRAFT, createdById: this.ctx.user!.userId },
      });
    } catch (e) {
      // Two people running the same campus-month at once: the unique (campus, month, year) refuses the second.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Payroll for this campus and month was just started by someone else');
      }
      throw e;
    }

    const staff = await this.db.staffProfile.findMany({
      where: { employmentStatus: 'ACTIVE', user: { campusId: dto.campusId } },
      select: { id: true },
    });
    const staffIds = staff.map((s) => s.id);

    // ⚠️ B11 — three queries for the whole campus, not three per staff member. The loop used to fetch each
    // person's salary, unpaid leave and absences separately.
    const [salaries, leaves, absences] = await Promise.all([
      this.db.salaryStructure.findMany({ where: { staffId: { in: staffIds }, effectiveFrom: { lte: monthEnd } }, orderBy: { effectiveFrom: 'desc' } }),
      this.db.staffLeave.findMany({ where: { staffId: { in: staffIds }, status: LeaveStatus.APPROVED, isUnpaid: true, fromDate: { lte: monthEnd }, toDate: { gte: monthStart } } }),
      this.db.staffAttendance.findMany({ where: { staffId: { in: staffIds }, status: AttendanceStatus.ABSENT, date: { gte: monthStart, lte: monthEnd } }, select: { staffId: true, date: true } }),
    ]);
    // Ordered newest first, so the first structure seen per person is the one in force for this month.
    const salaryOf = new Map<string, (typeof salaries)[number]>();
    for (const sal of salaries) if (!salaryOf.has(sal.staffId)) salaryOf.set(sal.staffId, sal);

    const rows: Prisma.PayslipCreateManyInput[] = [];
    for (const s of staff) {
      const salary = salaryOf.get(s.id);
      if (!salary) continue;

      const basic = Number(salary.basic);
      const allowances = sumValues(salary.allowances);
      const fixedDeductions = sumValues(salary.fixedDeductions);
      const gross = money(basic + allowances);

      const unpaidLeaveDays = leaves
        .filter((l) => l.staffId === s.id)
        .reduce((n, l) => {
          const from = new Date(Math.max(new Date(l.fromDate).getTime(), monthStart.getTime()));
          const to = new Date(Math.min(new Date(l.toDate).getTime(), monthEnd.getTime()));
          return n + workingDaysBetween(from, to, settings.weeklyOffDays, holidayISODates).length;
        }, 0);
      const absentDays = new Set(absences.filter((a) => a.staffId === s.id).map((a) => new Date(a.date).getUTCDate())).size;
      const perDay = workingDays > 0 ? basic / workingDays : 0;

      // Whether an absence costs money is the school's decision (G5), not this service's. Some
      // schools dock a day's basic; others treat teacher absence as a management matter and never
      // touch salary. Until now the code simply always deducted, and nobody could see that.
      //
      // Unpaid leave is deducted EITHER WAY: approved unpaid leave that does not reduce pay is
      // not unpaid leave. The switch governs unexplained absence only.
      const deductForAbsence = settings.payrollDeductsAbsence;
      const deductedDays = unpaidLeaveDays + (deductForAbsence ? absentDays : 0);
      const attendanceDeduction = money(deductedDays * perDay);
      const netPay = money(gross - fixedDeductions - attendanceDeduction);

      rows.push({
        schoolId: this.sid,
        runId: run.id,
        staffId: s.id,
        gross,
        attendanceDeduction,
        otherDeductions: fixedDeductions,
        netPay,
        // `deductForAbsence` is recorded on the payslip, not just applied: a payslip showing
        // 3 absent days and no deduction is otherwise indistinguishable from a bug, six months
        // later, to whoever is asked why.
        breakdown: {
          basic, allowances, fixedDeductions, workingDays,
          unpaidLeaveDays, absentDays, deductForAbsence, attendanceDeduction, netPay,
        } as Prisma.InputJsonValue,
      });
    }
    if (rows.length) await this.db.payslip.createMany({ data: rows });
    return { runId: run.id, alreadyExists: false, payslips: rows.length, excluded: staff.length - rows.length };
  }

  /**
   * Payroll runs for the payroll screen, newest period first, with the totals a reviewer needs (B9).
   * There was no list at all — only create, fetch-by-id and approve — so no screen could show past runs.
   */
  async listRuns(q: { campusId?: string; year?: number }) {
    const campusId = effectiveCampusFilter(this.ctx.user, q.campusId);
    const runs = await this.db.payrollRun.findMany({
      where: { ...(campusId ? { campusId } : {}), ...(q.year ? { year: q.year } : {}) },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      include: { payslips: { select: { netPay: true, paidAt: true } } },
      take: 60,
    });
    // PayrollRun has no campus relation; one lookup for the names rather than a schema change for a label.
    const names = new Map((await this.db.campus.findMany({ select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    return runs.map(({ payslips, ...r }) => ({
      ...r,
      campusName: names.get(r.campusId) ?? '',
      payslips: payslips.length,
      totalNet: money(payslips.reduce((n, p) => n + Number(p.netPay), 0)),
      paid: payslips.filter((p) => p.paidAt).length,
    }));
  }

  /**
   * Discard a DRAFT so it can be run again (B10).
   *
   * ⚠️ A draft used to block its campus-month forever: `run()` found it and returned `alreadyExists`. So an
   * absence corrected, a leave approved late, or a salary fixed after drafting could never reach that month's
   * pay. An APPROVED run is refused — once approved, the month is settled and dependent screens rely on it.
   */
  async discardDraft(runId: string) {
    const run = await this.db.payrollRun.findFirst({ where: { id: runId } });
    if (!run) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Payroll run not found');
    assertCampusAccess(this.ctx.user, run.campusId);
    if (run.status !== PayrollRunStatus.DRAFT) {
      throw new AppError(ErrorCodes.INVALID_STATE_TRANSITION, HttpStatus.CONFLICT, 'An approved payroll run cannot be discarded');
    }
    await this.db.payslip.deleteMany({ where: { runId } });
    await this.db.payrollRun.delete({ where: { id: runId } });
    await this.audit.record({
      action: AuditActions.PAYROLL_DRAFT_DISCARDED, entityType: 'PayrollRun', entityId: runId,
      oldValue: { campusId: run.campusId, month: run.month, year: run.year },
    });
  }

  async approve(runId: string) {
    const run = await this.db.payrollRun.findFirst({ where: { id: runId } });
    if (!run) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Payroll run not found');
    if (run.status !== PayrollRunStatus.DRAFT) {
      throw new AppError(ErrorCodes.INVALID_STATE_TRANSITION, HttpStatus.CONFLICT, `Run is ${run.status}`);
    }
    return this.db.payrollRun.update({ where: { id: runId }, data: { status: PayrollRunStatus.APPROVED, approvedById: this.ctx.user!.userId } });
  }

  async markPaid(payslipId: string, dto: MarkPaidDto) {
    const payslip = await this.db.payslip.findFirst({ where: { id: payslipId }, include: { run: true, staff: { select: { userId: true } } } });
    if (!payslip) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Payslip not found');
    const caller = this.ctx.user!;
    assertCampusAccess(caller, payslip.run.campusId);
    // Nobody records their own salary as received — the accountant's own payslip is marked by the owner.
    if (payslip.staff.userId === caller.userId) {
      throw new AppError(ErrorCodes.SELF_PAYMENT_FORBIDDEN, HttpStatus.FORBIDDEN, 'Someone else must record your own salary as paid');
    }
    if (payslip.run.status !== PayrollRunStatus.APPROVED) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Approve the run before recording disbursement');
    }
    // ⚠️ A second "mark paid" used to overwrite the first — a double click silently rewrote the payment date
    // and method of a salary already paid. Paid is recorded once.
    if (payslip.paidAt) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, `Already recorded as paid on ${payslip.paidAt.toISOString().slice(0, 10)}`);
    }
    const method = dto.method ?? 'CASH';
    const updated = await this.db.payslip.update({
      where: { id: payslipId },
      data: { paidAt: new Date(), paymentMethod: method as never, paymentRef: dto.reference, paidById: caller.userId },
    });
    await this.audit.record({
      action: AuditActions.PAYSLIP_MARKED_PAID, entityType: 'Payslip', entityId: payslipId,
      newValue: { runId: payslip.runId, staffId: payslip.staffId, netPay: Number(payslip.netPay), method, reference: dto.reference ?? null },
    });
    return updated;
  }

  async getRun(id: string) {
    const run = await this.db.payrollRun.findFirst({ where: { id } });
    if (!run) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Payroll run not found');
    assertCampusAccess(this.ctx.user, run.campusId);
    const payslips = await this.db.payslip.findMany({
      where: { runId: id },
      include: { staff: { select: { employeeCode: true, designation: true, fullName: true, userId: true, user: { select: { email: true } } } } },
    });
    // Who recorded each payment — one lookup for the run, not one per row.
    const payerIds = [...new Set(payslips.map((p) => p.paidById).filter((x): x is string => !!x))];
    const payers = new Map((payerIds.length
      ? await this.db.user.findMany({ where: { id: { in: payerIds } }, select: { id: true, email: true } })
      : []).map((u) => [u.id, u.email]));
    // ⚠️ Staff with no salary structure were skipped SILENTLY, so a teacher could be left out of payroll and
    // nobody reviewing the run would see it. They are named, so the omission is a decision, not an accident.
    const excluded = await this.db.staffProfile.findMany({
      where: { employmentStatus: 'ACTIVE', user: { campusId: run.campusId }, id: { notIn: payslips.map((p) => p.staffId) } },
      select: { id: true, employeeCode: true, user: { select: { email: true } } },
    });
    return {
      ...run,
      campusName: (await this.db.campus.findFirst({ where: { id: run.campusId }, select: { name: true } }))?.name ?? '',
      payslips: payslips.map(({ staff, ...p }) => ({
        ...p, employeeCode: staff.employeeCode, designation: staff.designation, email: staff.user.email,
        staffName: staff.fullName ?? staff.user.email, staffUserId: staff.userId,
        paidBy: p.paidById ? (payers.get(p.paidById) ?? null) : null,
      })),
      excluded: excluded.map((e) => ({ staffId: e.id, employeeCode: e.employeeCode, email: e.user.email, reason: 'No salary structure for this month' })),
    };
  }

  async myPayslips() {
    const staff = await this.db.staffProfile.findFirst({ where: { userId: this.ctx.user!.userId } });
    if (!staff) return [];
    // Newest pay period first. Payslip has no createdAt, and the PK is a random UUID, so
    // order by the run's period rather than by id (which would be arbitrary).
    // ⚠️ APPROVED runs only. This returned every payslip, so a teacher saw a draft figure the owner could still
    // discard or change. A payslip exists for its owner from the moment the school commits to it.
    const rows = await this.db.payslip.findMany({
      where: { staffId: staff.id, run: { status: PayrollRunStatus.APPROVED } },
      include: { run: { select: { month: true, year: true } } },
      orderBy: [{ run: { year: 'desc' } }, { run: { month: 'desc' } }],
    });
    return rows.map(({ run, ...p }) => ({ ...p, month: run.month, year: run.year, state: p.paidAt ? 'PAID' : 'APPROVED' }));
  }

  /**
   * Render the payslip PDF (§13, §15), upload it to storage, and return a short-lived
   * presigned GET. The staff owner or an admin may fetch it — the ownership check runs
   * here (not a guard) so it reads inside the RLS-scoped tx (§22.8).
   */
  async payslipPdf(payslipId: string): Promise<{ fileKey: string; url: string; expiresInSeconds: number }> {
    const payslip = await this.db.payslip.findFirst({
      where: { id: payslipId },
      include: { run: true, staff: { include: { user: { select: { email: true } } } } },
    });
    if (!payslip) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Payslip not found');

    const caller = this.ctx.user!;
    const isOwner = caller.roles.includes('OWNER_ADMIN');
    const isAdmin = caller.roles.some((r) => r === 'OWNER_ADMIN' || r === 'CAMPUS_ADMIN' || r === 'ACCOUNTANT');
    if (!isAdmin && payslip.staff.userId !== caller.userId) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Not your payslip');
    }
    // ⚠️ "An admin" is not "any admin": a payslip is salary data, and a campus admin reads their own
    // campus's payroll, not another's. Without this a campus-A admin could download a campus-B teacher's
    // salary slip. A staff member's OWN payslip is always theirs, whichever campus holds the run.
    if (isAdmin && payslip.staff.userId !== caller.userId) assertCampusAccess(caller, payslip.run.campusId);
    // Campus first: another campus's payslip is refused as such, draft or not.
    // ⚠️ A draft is not a payslip yet. Anyone but the owner and the campus accountant (who prepare it) is told it
    // does not exist — 404, not 403, so a draft's existence is not confirmed to the person it is about.
    const preparer = isOwner || (caller.roles.includes('ACCOUNTANT') && payslip.staff.userId !== caller.userId);
    if (payslip.run.status !== PayrollRunStatus.APPROVED && !preparer) {
      throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Payslip not found');
    }

    const schoolName = (await this.db.school.findFirst({ where: { id: this.sid } }))?.name ?? 'School';
    const period = `${MONTHS[payslip.run.month - 1]} ${payslip.run.year}`;
    const b = (payslip.breakdown ?? {}) as { basic?: number; allowances?: number; unpaidLeaveDays?: number; absentDays?: number; deductForAbsence?: boolean; workingDays?: number };
    const buffer = await this.pdf.payslip({
      schoolName,
      staffName: payslip.staff.fullName ?? payslip.staff.user.email,
      basic: Number(b.basic ?? payslip.gross),
      allowances: Number(b.allowances ?? 0),
      workingDays: b.workingDays ?? null,
      unpaidLeaveDays: b.unpaidLeaveDays ?? 0,
      absentDays: b.deductForAbsence ? (b.absentDays ?? 0) : 0,
      employeeCode: payslip.staff.employeeCode,
      period,
      gross: Number(payslip.gross),
      attendanceDeduction: Number(payslip.attendanceDeduction),
      otherDeductions: Number(payslip.otherDeductions),
      netPay: Number(payslip.netPay),
    });
    const fileKey = `payslips/${this.sid}/${payslipId}.pdf`;
    await this.storage.putObject(fileKey, buffer, 'application/pdf');
    const url = await this.storage.presignGet(fileKey, 600, `payslip-${period.replace(' ', '-')}.pdf`);
    return { fileKey, url, expiresInSeconds: 600 };
  }

  // ── helpers ──────────────────────────────────────────────────────────────────
  // The month's working-day count used to be computed here from a local weekday table. It is now
  // `workingDaysBetween` from @common — the same function the leave count and the attendance
  // deadline use, because a second implementation of "which days does this school work" is a
  // second answer waiting to disagree with the first.
}
