import { Inject, Injectable } from '@nestjs/common';
import { Prisma, SmsStatus } from '@prisma/client';
import { ErrorCodes, parseSchoolSettings, TenantContext } from '@common';
import { TenantPrismaService } from '@database';
import { CreditsService } from './credits.service';
import { computeSegments, renderTemplate } from './sms-segments';
import { SMS_GATEWAY, type SmsGateway } from './sms-gateway';
import { DEFAULT_TEMPLATES, type SmsTriggerKey } from './sms-templates.defaults';
import type { SmsJob } from './sms.types';

interface OutboundRefs {
  studentId?: string;
  userId?: string;
  invoiceId?: string;
}

/**
 * SMS send pipeline (blueprint §14, §26). `dispatch` is the unit of work the worker
 * runs per job (inside withTenant); it resolves recipients, renders the template,
 * checks credits (with an overdraft buffer for critical sends), calls the gateway,
 * and records an SmsLog. Unverified numbers never receive student PII (§14).
 */
@Injectable()
export class SmsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly credits: CreditsService,
    @Inject(SMS_GATEWAY) private readonly gateway: SmsGateway,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  async dispatch(job: SmsJob): Promise<void> {
    switch (job.type) {
      case 'ABSENCE':
        return this.dispatchAbsence(job);
      case 'LEAVE_STATUS':
        return this.dispatchLeaveStatus(job);
      case 'FEE_RECEIPT':
        return this.dispatchReceipt(job);
      case 'RESULT_READY':
        return this.dispatchResultReady(job);
      case 'SCHOOL_CLOSED':
        return this.dispatchSchoolClosed(job);
      case 'FEE_REMINDER':
        return this.dispatchFeeReminder(job);
      case 'MANUAL':
        // No dedupe key — a school may deliberately send the same broadcast twice.
        for (const to of job.recipients) await this.sendOne(to, job.body, 'MANUAL', {}, false);
        return;
    }
  }

  private async dispatchAbsence(job: Extract<SmsJob, { type: 'ABSENCE' }>): Promise<void> {
    const student = await this.db.student.findFirst({ where: { id: job.studentId } });
    const guardian = await this.primaryGuardian(job.studentId);
    if (!student || !guardian) return; // nothing to notify

    const schoolName = await this.schoolName();
    if (!guardian.phoneVerifiedAt) {
      await this.logUnverified(guardian.phone, 'ABSENCE', { studentId: job.studentId });
      return;
    }
    const body = renderTemplate(await this.templateBody('ABSENCE'), {
      studentName: student.fullName,
      date: job.date,
      schoolName,
    });
    // Transactional send: opt-out is ignored; overdraft buffer applies.
    // One absence notice per student per day, however many times the job is delivered.
    await this.sendOne(guardian.phone, body, 'ABSENCE', { studentId: job.studentId }, true, `ABSENCE:${job.studentId}:${job.date}`);
  }

  /**
   * "School will be closed on …" to one student's guardian.
   *
   * ⚠️ **NOT transactional.** Unlike an absence notice, this is an announcement, so opt-out is
   * respected and it does not spend the overdraft buffer. A family that asked to stop receiving
   * texts must not be overridden by a broadcast — that is what an opt-out means.
   *
   * ⚠️ The dedupe key is `(holiday, student)`. Editing a closure, re-saving it, or a redelivered
   * job must not text 400 families twice; the queue's dedupe is the only thing standing between a
   * double-click and a duplicated bill.
   */
  private async dispatchSchoolClosed(job: Extract<SmsJob, { type: 'SCHOOL_CLOSED' }>): Promise<void> {
    const student = await this.db.student.findFirst({ where: { id: job.studentId } });
    const guardian = await this.primaryGuardian(job.studentId);
    if (!student || !guardian) return;

    if (!guardian.phoneVerifiedAt) {
      await this.logUnverified(guardian.phone, 'SCHOOL_CLOSED', { studentId: job.studentId });
      return;
    }
    const body = renderTemplate(await this.templateBody('SCHOOL_CLOSED'), {
      date: job.date,
      reason: job.reason,
      studentName: student.fullName,
      schoolName: await this.schoolName(),
    });
    await this.sendOne(
      guardian.phone, body, 'SCHOOL_CLOSED', { studentId: job.studentId }, false,
      `SCHOOL_CLOSED:${job.holidayId}:${job.studentId}`,
    );
  }

  /**
   * A fee reminder to the primary guardian.
   *
   * ⚠️ NOT transactional: a reminder is a nudge the guardian may opt out of, unlike a receipt for money they
   * paid. `sendOne(..., false, …)` therefore honours opt-out and the credit balance without overdraft.
   */
  private async dispatchFeeReminder(job: Extract<SmsJob, { type: 'FEE_REMINDER' }>): Promise<void> {
    const student = await this.db.student.findFirst({ where: { id: job.studentId } });
    const guardian = await this.primaryGuardian(job.studentId);
    if (!student || !guardian) return;
    if (!guardian.phoneVerifiedAt) {
      await this.logUnverified(guardian.phone, 'FEE_REMINDER', { studentId: job.studentId });
      return;
    }
    const body = renderTemplate(await this.templateBody('FEE_REMINDER'), {
      amount: job.amount.toLocaleString('en-PK'),
      dueDate: job.dueDate,
      studentName: student.fullName,
      schoolName: await this.schoolName(),
    });
    await this.sendOne(guardian.phone, body, 'FEE_REMINDER', { studentId: job.studentId }, false, `FEE_REMINDER:${job.studentId}:${job.day}`);
  }

  private async dispatchLeaveStatus(job: Extract<SmsJob, { type: 'LEAVE_STATUS' }>): Promise<void> {
    const student = await this.db.student.findFirst({ where: { id: job.studentId } });
    const guardian = await this.primaryGuardian(job.studentId);
    if (!student || !guardian || !guardian.phoneVerifiedAt) {
      if (guardian && !guardian.phoneVerifiedAt) await this.logUnverified(guardian.phone, 'LEAVE_STATUS', { studentId: job.studentId });
      return;
    }
    const body = renderTemplate(await this.templateBody('LEAVE_STATUS'), {
      name: student.fullName,
      status: job.status,
      schoolName: await this.schoolName(),
    });
    // No dedupe key: the job carries only studentId+status, and a student legitimately gets the
    // same status more than once (a second leave request, or APPROVED → REJECTED → APPROVED).
    // Keying on those two fields would silently swallow a real notification, which is worse
    // than a rare duplicate. Give SmsJob a leaveId if this needs claiming later.
    await this.sendOne(guardian.phone, body, 'LEAVE_STATUS', { studentId: job.studentId }, false);
  }

  private async dispatchReceipt(job: Extract<SmsJob, { type: 'FEE_RECEIPT' }>): Promise<void> {
    const student = await this.db.student.findFirst({ where: { id: job.studentId } });
    const guardian = await this.primaryGuardian(job.studentId);
    if (!student || !guardian) return;
    if (!guardian.phoneVerifiedAt) {
      await this.logUnverified(guardian.phone, 'FEE_RECEIPT', { studentId: job.studentId, invoiceId: job.invoiceId });
      return;
    }
    const body = renderTemplate(await this.templateBody('FEE_RECEIPT'), {
      amount: job.amount,
      studentName: student.fullName,
      receiptNo: job.receiptNo,
      schoolName: await this.schoolName(),
    });
    // Transactional (critical) send — overdraft buffer applies.
    // Receipt numbers are unique per payment, so this is a natural once-per-event key.
    await this.sendOne(guardian.phone, body, 'FEE_RECEIPT', { studentId: job.studentId, invoiceId: job.invoiceId }, true, `FEE_RECEIPT:${job.invoiceId}:${job.receiptNo}`);
  }

  private async dispatchResultReady(job: Extract<SmsJob, { type: 'RESULT_READY' }>): Promise<void> {
    const student = await this.db.student.findFirst({ where: { id: job.studentId } });
    const guardian = await this.primaryGuardian(job.studentId);
    if (!student || !guardian) return;
    if (!guardian.phoneVerifiedAt) {
      await this.logUnverified(guardian.phone, 'RESULT_READY', { studentId: job.studentId });
      return;
    }
    const body = renderTemplate(await this.templateBody('RESULT_READY'), {
      studentName: student.fullName,
      term: job.term,
      schoolName: await this.schoolName(),
    });
    await this.sendOne(guardian.phone, body, 'RESULT_READY', { studentId: job.studentId }, false, `RESULT_READY:${job.studentId}:${job.term}`);
  }

  /** The atomic single send: credit gate -> SmsLog -> gateway -> SENT/FAILED + debit. */
  private async sendOne(
    recipient: string,
    body: string,
    templateKey: SmsTriggerKey,
    refs: OutboundRefs,
    critical: boolean,
    /** Stable per-event key. When given, the QUEUED insert below claims it, so a redelivered
     *  job is dropped instead of re-sending. Omit for sends that may legitimately repeat. */
    dedupeKey?: string,
  ): Promise<void> {
    const { segments } = computeSegments(body);
    if (!(await this.creditsAllow(segments, critical))) {
      // Deliberately NOT claimed: this send never happened, so a retry once the school tops
      // up its credits must be allowed through.
      await this.db.smsLog.create({
        data: {
          schoolId: this.ctx.requireSchoolId(),
          recipient,
          message: body,
          templateKey,
          segments,
          status: SmsStatus.FAILED,
          failReason: ErrorCodes.INSUFFICIENT_SMS_CREDITS,
          ...refs,
        },
      });
      return;
    }

    // The QUEUED row is written BEFORE the gateway call so it doubles as the idempotency
    // claim — losing the race means another delivery of this job already sent it.
    let log;
    try {
      log = await this.db.smsLog.create({
        data: {
          schoolId: this.ctx.requireSchoolId(),
          recipient,
          message: body,
          templateKey,
          segments,
          status: SmsStatus.QUEUED,
          dedupeKey,
          ...refs,
        },
      });
    } catch (e) {
      if (dedupeKey && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return; // already sent for this event — drop the duplicate silently
      }
      throw e;
    }

    const result = await this.gateway.send(recipient, body);
    if (result.accepted) {
      await this.db.smsLog.update({
        where: { id: log.id },
        data: { status: SmsStatus.SENT, sentAt: new Date(), gatewayMessageId: result.gatewayMessageId },
      });
      await this.credits.debit(segments, log.id);
    } else {
      await this.db.smsLog.update({
        where: { id: log.id },
        data: { status: SmsStatus.FAILED, failReason: result.error ?? 'GATEWAY_REJECTED' },
      });
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────────
  private async creditsAllow(segments: number, critical: boolean): Promise<boolean> {
    const balance = await this.credits.balance();
    const overdraft = critical ? parseSchoolSettings((await this.settings()) ?? {}).smsOverdraftSegments : 0;
    return balance - segments >= -overdraft;
  }

  private async primaryGuardian(studentId: string) {
    const link = await this.db.studentGuardian.findFirst({
      where: { studentId, isPrimary: true },
      include: { parent: { select: { phone: true, phoneVerifiedAt: true, smsOptOut: true } } },
    });
    return link?.parent ?? null;
  }

  private async logUnverified(recipient: string, templateKey: SmsTriggerKey, refs: OutboundRefs): Promise<void> {
    await this.db.smsLog.create({
      data: {
        schoolId: this.ctx.requireSchoolId(),
        recipient,
        message: '(withheld: unverified number)',
        templateKey,
        segments: 0,
        status: SmsStatus.FAILED,
        failReason: ErrorCodes.PHONE_UNVERIFIED,
        ...refs,
      },
    });
  }

  private async templateBody(key: SmsTriggerKey): Promise<string> {
    const tmpl = await this.db.smsTemplate.findFirst({ where: { triggerKey: key } });
    return tmpl?.body || DEFAULT_TEMPLATES[key];
  }

  private async schoolName(): Promise<string> {
    const s = await this.db.school.findFirst({ where: { id: this.ctx.requireSchoolId() } });
    return s?.name ?? 'School';
  }

  private async settings(): Promise<unknown> {
    const s = await this.db.school.findFirst({ where: { id: this.ctx.requireSchoolId() } });
    return s?.settings;
  }
}
