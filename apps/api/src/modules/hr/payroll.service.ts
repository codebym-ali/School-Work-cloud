import { HttpStatus, Injectable } from '@nestjs/common';
import { AttendanceStatus, LeaveStatus, PayrollRunStatus, Prisma } from '@prisma/client';
import { AppError, ErrorCodes, parseSchoolSettings, PdfService, StorageService, TenantContext, workingDaysBetween } from '@common';
import { TenantPrismaService } from '@database';
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
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }
  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  async run(dto: RunPayrollDto) {
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

    const run = await this.db.payrollRun.create({
      data: { schoolId: this.sid, campusId: dto.campusId, month: dto.month, year: dto.year, status: PayrollRunStatus.DRAFT, createdById: this.ctx.user!.userId },
    });

    const staff = await this.db.staffProfile.findMany({
      where: { employmentStatus: 'ACTIVE', user: { campusId: dto.campusId } },
    });

    let count = 0;
    for (const s of staff) {
      const salary = await this.db.salaryStructure.findFirst({
        where: { staffId: s.id, effectiveFrom: { lte: monthEnd } },
        orderBy: { effectiveFrom: 'desc' },
      });
      if (!salary) continue;

      const basic = Number(salary.basic);
      const allowances = sumValues(salary.allowances);
      const fixedDeductions = sumValues(salary.fixedDeductions);
      const gross = money(basic + allowances);

      const unpaidLeaveDays = await this.unpaidLeaveDays(s.id, monthStart, monthEnd, settings.weeklyOffDays, holidayISODates);
      const absentDays = await this.absentDays(s.id, monthStart, monthEnd);
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

      await this.db.payslip.create({
        data: {
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
        },
      });
      count++;
    }
    return { runId: run.id, alreadyExists: false, payslips: count };
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
    const payslip = await this.db.payslip.findFirst({ where: { id: payslipId }, include: { run: true } });
    if (!payslip) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Payslip not found');
    if (payslip.run.status !== PayrollRunStatus.APPROVED) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Approve the run before recording disbursement');
    }
    return this.db.payslip.update({
      where: { id: payslipId },
      data: { paidAt: new Date(), paymentMethod: dto.method as never, paymentRef: dto.reference },
    });
  }

  async getRun(id: string) {
    const run = await this.db.payrollRun.findFirst({ where: { id } });
    if (!run) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Payroll run not found');
    const payslips = await this.db.payslip.findMany({ where: { runId: id } });
    return { ...run, payslips };
  }

  async myPayslips() {
    const staff = await this.db.staffProfile.findFirst({ where: { userId: this.ctx.user!.userId } });
    if (!staff) return [];
    // Newest pay period first. Payslip has no createdAt, and the PK is a random UUID, so
    // order by the run's period rather than by id (which would be arbitrary).
    return this.db.payslip.findMany({
      where: { staffId: staff.id },
      orderBy: [{ run: { year: 'desc' } }, { run: { month: 'desc' } }],
    });
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
    const isAdmin = caller.roles.some((r) => r === 'OWNER_ADMIN' || r === 'CAMPUS_ADMIN');
    if (!isAdmin && payslip.staff.userId !== caller.userId) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Not your payslip');
    }

    const schoolName = (await this.db.school.findFirst({ where: { id: this.sid } }))?.name ?? 'School';
    const period = `${MONTHS[payslip.run.month - 1]} ${payslip.run.year}`;
    const buffer = await this.pdf.payslip({
      schoolName,
      staffName: payslip.staff.user.email,
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

  /**
   * Unpaid-leave days falling in this month — counted as WORKING days, not calendar days.
   *
   * It used to be calendar days, which over-deducted every time: the rate applied to them is
   * `basic / workingDays`, a denominator that already excludes weekly offs and closures, so a
   * seven-day leave across a six-working-day week was charged as seven sixths of a week. The
   * weekly off is not a day the person took off — it was already not a working day.
   */
  private async unpaidLeaveDays(
    staffId: string,
    monthStart: Date,
    monthEnd: Date,
    weeklyOff: string[],
    holidayISODates: string[],
  ): Promise<number> {
    const leaves = await this.db.staffLeave.findMany({
      where: { staffId, status: LeaveStatus.APPROVED, isUnpaid: true, fromDate: { lte: monthEnd }, toDate: { gte: monthStart } },
    });
    let days = 0;
    for (const l of leaves) {
      const from = new Date(Math.max(new Date(l.fromDate).getTime(), monthStart.getTime()));
      const to = new Date(Math.min(new Date(l.toDate).getTime(), monthEnd.getTime()));
      days += workingDaysBetween(from, to, weeklyOff, holidayISODates).length;
    }
    return days;
  }

  private async absentDays(staffId: string, monthStart: Date, monthEnd: Date): Promise<number> {
    const rows = await this.db.staffAttendance.findMany({
      where: { staffId, status: AttendanceStatus.ABSENT, date: { gte: monthStart, lte: monthEnd } },
      select: { date: true },
    });
    return new Set(rows.map((r) => new Date(r.date).getUTCDate())).size;
  }
}
