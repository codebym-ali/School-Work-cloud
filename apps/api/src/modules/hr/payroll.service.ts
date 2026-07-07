import { HttpStatus, Injectable } from '@nestjs/common';
import { AttendanceStatus, LeaveStatus, PayrollRunStatus, Prisma } from '@prisma/client';
import { AppError, ErrorCodes, parseSchoolSettings, PdfService, StorageService, TenantContext } from '@common';
import { TenantPrismaService } from '@database';
import type { MarkPaidDto, RunPayrollDto } from './dto/hr.dto';

const money = (n: number): number => Math.round(n * 100) / 100;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const sumValues = (o: unknown): number =>
  o && typeof o === 'object' ? Object.values(o as Record<string, number>).reduce((s, v) => s + Number(v), 0) : 0;
const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

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
    const workingDays = await this.workingDays(dto.year, dto.month, dto.campusId, settings.weeklyOffDays);

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

      const unpaidLeaveDays = await this.unpaidLeaveDays(s.id, monthStart, monthEnd);
      const absentDays = await this.absentDays(s.id, monthStart, monthEnd);
      const perDay = workingDays > 0 ? basic / workingDays : 0;
      const attendanceDeduction = money((unpaidLeaveDays + absentDays) * perDay);
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
          breakdown: { basic, allowances, fixedDeductions, workingDays, unpaidLeaveDays, absentDays, attendanceDeduction, netPay } as Prisma.InputJsonValue,
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
    return this.db.payslip.findMany({ where: { staffId: staff.id }, orderBy: { id: 'desc' } });
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
  private async workingDays(year: number, month: number, campusId: string, weeklyOff: string[]): Promise<number> {
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const holidays = await this.db.holiday.findMany({
      where: { date: { gte: new Date(Date.UTC(year, month - 1, 1)), lte: new Date(Date.UTC(year, month, 0)) }, OR: [{ campusId }, { campusId: null }] },
    });
    const holidaySet = new Set(holidays.map((h) => new Date(h.date).getUTCDate()));
    let count = 0;
    for (let d = 1; d <= days; d++) {
      const dow = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
      if (!weeklyOff.includes(WEEKDAYS[dow]) && !holidaySet.has(d)) count++;
    }
    return count;
  }

  private async unpaidLeaveDays(staffId: string, monthStart: Date, monthEnd: Date): Promise<number> {
    const leaves = await this.db.staffLeave.findMany({
      where: { staffId, status: LeaveStatus.APPROVED, isUnpaid: true, fromDate: { lte: monthEnd }, toDate: { gte: monthStart } },
    });
    let days = 0;
    for (const l of leaves) {
      const from = new Date(Math.max(new Date(l.fromDate).getTime(), monthStart.getTime()));
      const to = new Date(Math.min(new Date(l.toDate).getTime(), monthEnd.getTime()));
      days += Math.floor((to.getTime() - from.getTime()) / 86400000) + 1;
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
