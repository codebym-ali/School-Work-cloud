import { HttpStatus, Injectable } from '@nestjs/common';
import { EnrollmentStatus, FeeInvoiceStatus } from '@prisma/client';
import { AppError, assertCampusAccess, assertOwnerOverride, AuditActions, ErrorCodes, TenantContext } from '@common';
import { AuditService, TenantPrismaService } from '@database';
import { InvoicingService } from '../fees/invoicing.service';

export interface WithdrawInput {
  reason: string;
  overrideFeeClearance?: boolean;
  leavingDate?: string;
}

/** Invoice statuses that still carry an unpaid balance. */
const OWING = [FeeInvoiceStatus.PENDING, FeeInvoiceStatus.PARTIAL, FeeInvoiceStatus.OVERDUE];

/**
 * The first day an invoice's billing period covers. A monthly invoice bills its month; an annual one
 * (`month` null) is treated as starting with its year's first month, so it always counts as begun.
 */
function periodStart(inv: { month: number | null; year: number }): Date {
  return new Date(Date.UTC(inv.year, (inv.month ?? 1) - 1, 1));
}

/**
 * Student withdrawal (blueprint §15). Closes the enrolment, waives invoices for months the student was
 * no longer enrolled for, disables the portal login, and records who did it and why.
 *
 * The unpaid-fees safeguard remains: a student who still owes for a month that has BEGUN cannot be
 * withdrawn unless an OWNER_ADMIN overrides (the balance stays on record — withdrawal is not a write-off,
 * Decision D6).
 *
 * NOTE: digital certificate issuance (leaving / fee-clearance) was removed on 2026-09-19 — schools issue
 * those on paper now. Withdrawal no longer produces any document.
 */
@Injectable()
export class WithdrawalService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly audit: AuditService,
    private readonly invoicing: InvoicingService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  /** Student withdrawal workflow (§15). */
  async withdraw(studentId: string, input: WithdrawInput) {
    assertOwnerOverride(this.ctx.user, input.overrideFeeClearance, 'the unpaid-fees check at withdrawal');

    const student = await this.db.student.findFirst({
      where: { id: studentId },
      include: { enrollments: { where: { status: EnrollmentStatus.ACTIVE }, select: { campusId: true, startedAt: true } } },
    });
    if (!student) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Student not found');
    // ⚠️ Found by id alone — RLS scopes that to the school, not the campus. A campus admin could
    // otherwise withdraw another campus's student and disable their login. A student with no ACTIVE
    // enrolment has no campus to check against, and is refused to a campus-bound caller.
    const campusId = student.enrollments[0]?.campusId ?? null;
    assertCampusAccess(this.ctx.user, campusId);
    if (!student.enrollments.length) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'This student is not currently enrolled');
    }

    const leftOn = input.leavingDate ? new Date(`${input.leavingDate.slice(0, 10)}T00:00:00Z`) : new Date();
    if (leftOn.getTime() > Date.now() + 86_400_000) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'The leaving date cannot be in the future');
    }
    // ⚠️ The enrolment carries a CHECK (chk_enrollment_dates) that ended_at >= started_at. A leaving
    // date BEFORE the admission date is invalid — say so with a 422 rather than letting the DB throw a
    // 500. And a student admitted and withdrawn on the SAME day is legitimate: `started_at` carries the
    // admission timestamp while `leftOn` is midnight, so clamp `endedAt` up to `started_at` to satisfy
    // the check without rejecting a same-day withdrawal.
    const startedAt = student.enrollments[0].startedAt;
    const startDay = new Date(Date.UTC(startedAt.getUTCFullYear(), startedAt.getUTCMonth(), startedAt.getUTCDate()));
    if (leftOn < startDay) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'The leaving date cannot be before the admission date');
    }
    const endedAt = leftOn.getTime() >= startedAt.getTime() ? leftOn : startedAt;

    // ⚠️ Invoices already raised for months AFTER the student left are not owed — the student was not
    // enrolled for them. They are closed with a waiver line whose reason says exactly why. Anything for
    // a month that had begun stays owed: withdrawal is not a write-off (Decision D6).
    const owing = await this.db.feeInvoice.findMany({ where: { studentId, status: { in: OWING } }, select: { id: true, month: true, year: true } });
    const afterLeaving = owing.filter((inv) => periodStart(inv) > leftOn);
    for (const inv of afterLeaving) {
      await this.invoicing.waive(inv.id, { reason: `Withdrawn on ${leftOn.toISOString().slice(0, 10)}: not enrolled for this period` });
    }

    const cleared = await this.feeCleared(studentId, leftOn);
    if (!input.overrideFeeClearance && !cleared) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Unpaid invoices exist; clear fees or override');
    }

    await this.db.studentEnrollment.updateMany({
      where: { studentId, status: EnrollmentStatus.ACTIVE },
      data: { status: EnrollmentStatus.WITHDRAWN, endedAt },
    });
    await this.db.student.update({ where: { id: studentId }, data: { isActive: false } });
    if (student.userId) {
      await this.db.user.update({ where: { id: student.userId }, data: { status: 'DISABLED' } });
    }

    // Every withdrawal is audited as what it is. The override gets its own entry, and only when fees
    // were actually owed — so the log can answer "who let a student leave owing money?".
    await this.audit.record({
      action: AuditActions.STUDENT_WITHDRAWN,
      entityType: 'Student',
      entityId: studentId,
      reason: input.reason,
      newValue: { leavingDate: leftOn.toISOString().slice(0, 10), waivedInvoicesAfterLeaving: afterLeaving.length },
    });
    if (!cleared) {
      await this.audit.record({
        action: AuditActions.WITHDRAWAL_FEE_OVERRIDE,
        entityType: 'Student',
        entityId: studentId,
        reason: input.reason,
        newValue: { overrode: true },
      });
    }
    return {
      status: 'WITHDRAWN' as const,
      waivedInvoicesAfterLeaving: afterLeaving.length,
      leftOwing: !cleared,
    };
  }

  /**
   * Does this student owe anything for a period that has BEGUN by `asOf`?
   *
   * ⚠️ (B6) An invoice raised early for a month that has not started is not yet owed — so a student
   * whose next month was already billed can still be withdrawn without an override.
   */
  private async feeCleared(studentId: string, asOf: Date = new Date()): Promise<boolean> {
    const unpaid = await this.db.feeInvoice.findMany({ where: { studentId, status: { in: OWING } }, select: { month: true, year: true } });
    return !unpaid.some((inv) => periodStart(inv) <= asOf);
  }
}
