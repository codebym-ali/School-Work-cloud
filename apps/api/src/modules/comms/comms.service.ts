import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { EnrollmentStatus, SmsStatus } from '@prisma/client';
import {
  AppError,
  AuditActions,
  effectiveCampusFilter,
  ENV,
  ErrorCodes,
  paginate,
  TenantContext,
  toSkipTake,
  type Env,
  type Paginated,
} from '@common';
import { AuditService, PlatformPrismaService, TenantPrismaService } from '@database';
import { chunk, resolveAudience } from './broadcast/broadcast-audience';
import { CreditsService } from './sms/credits.service';
import { SmsProducer } from './sms/sms-producer.service';
import { computeSegments } from './sms/sms-segments';
import { DEFAULT_TEMPLATES, SMS_TRIGGER_KEYS } from './sms/sms-templates.defaults';
import type { BroadcastAudienceDto, BroadcastSendDto, ManualSendDto, SmsLogQuery, SmsWebhookDto, UpsertTemplateDto } from './dto/comms.dto';

/** API-facing comms operations (blueprint §14, §24): templates, logs, credits, manual send, webhooks. */
@Injectable()
export class CommsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly platform: PlatformPrismaService,
    private readonly ctx: TenantContext,
    private readonly credits: CreditsService,
    private readonly producer: SmsProducer,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  // ── Templates ────────────────────────────────────────────────────────────────
  async listTemplates() {
    const rows = await this.db.smsTemplate.findMany();
    const byKey = new Map(rows.map((r) => [r.triggerKey, r.body]));
    // Show effective templates (stored override or seeded default) for every trigger.
    return SMS_TRIGGER_KEYS.map((key) => ({ triggerKey: key, body: byKey.get(key) ?? DEFAULT_TEMPLATES[key] }));
  }

  async upsertTemplate(dto: UpsertTemplateDto) {
    const existing = await this.db.smsTemplate.findFirst({ where: { triggerKey: dto.triggerKey } });
    if (existing) {
      return this.db.smsTemplate.update({
        where: { id: existing.id },
        data: { body: dto.body, updatedById: this.ctx.user?.userId },
      });
    }
    return this.db.smsTemplate.create({
      data: {
        schoolId: this.ctx.requireSchoolId(),
        triggerKey: dto.triggerKey,
        body: dto.body,
        updatedById: this.ctx.user?.userId,
      },
    });
  }

  // ── Credits + logs ───────────────────────────────────────────────────────────
  async creditBalance(): Promise<{ balance: number }> {
    return { balance: await this.credits.balance() };
  }

  async listLogs(q: SmsLogQuery): Promise<Paginated<unknown>> {
    const where = {
      ...(q.status ? { status: q.status as SmsStatus } : {}),
      ...(q.templateKey ? { templateKey: q.templateKey } : {}),
    };
    const { skip, take } = toSkipTake(q);
    const [rows, total] = await Promise.all([
      this.db.smsLog.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.db.smsLog.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  // ── Manual send ────────────────────────────────────────────────────────────────
  async sendManual(dto: ManualSendDto): Promise<{ recipients: number; estimatedSegments: number }> {
    const perMessage = computeSegments(dto.body).segments;
    await this.producer.enqueueManual({
      type: 'MANUAL',
      schoolId: this.ctx.requireSchoolId(),
      recipients: dto.recipients,
      body: dto.body,
    });
    return { recipients: dto.recipients.length, estimatedSegments: perMessage * dto.recipients.length };
  }

  // ── Broadcast (GAP-15) ─────────────────────────────────────────────────────────
  /**
   * Resolve a broadcast's audience on the SERVER: active students in scope, their primary guardian, one
   * phone per family, verified and not opted out. The client never sends phone numbers.
   *
   * ⚠️ Campus is forced for a campus-bound caller, and class/section only narrow WITHIN it — a campus-A admin
   * naming a campus-B section gets an audience of zero, not campus B's parents.
   */
  private async audience(dto: BroadcastAudienceDto) {
    const campusId = effectiveCampusFilter(this.ctx.user, dto.campusId);
    const enrollments = await this.db.studentEnrollment.findMany({
      where: {
        status: EnrollmentStatus.ACTIVE,
        student: { deletedAt: null },
        ...(campusId ? { campusId } : {}),
        ...(dto.classId ? { classId: dto.classId } : {}),
        ...(dto.sectionId ? { sectionId: dto.sectionId } : {}),
      },
      select: {
        studentId: true,
        student: {
          select: {
            guardians: {
              where: { isPrimary: true },
              take: 1,
              select: { parent: { select: { phone: true, phoneVerifiedAt: true, smsOptOut: true } } },
            },
          },
        },
      },
    });
    return resolveAudience(enrollments.map((e) => {
      const p = e.student.guardians[0]?.parent;
      return { studentId: e.studentId, guardian: p ? { phone: p.phone, verified: p.phoneVerifiedAt !== null, optedOut: p.smsOptOut } : null };
    }));
  }

  async previewBroadcast(dto: BroadcastAudienceDto) {
    const a = await this.audience(dto);
    const segmentsPerMessage = computeSegments(dto.body).segments;
    const totalSegments = segmentsPerMessage * a.recipients.length;
    const balance = await this.credits.balance();
    return {
      students: a.students, recipients: a.recipients.length, skipped: a.skipped,
      segmentsPerMessage, totalSegments, balance, enoughCredits: balance >= totalSegments,
    };
  }

  /**
   * ⚠️ **All or nothing on credits.** A broadcast is not critical, so each send past the balance would fail
   * on its own — half of Class 5 told school is closed tomorrow, half not. Refused up front instead.
   */
  async sendBroadcast(dto: BroadcastSendDto) {
    const a = await this.audience(dto);
    if (a.recipients.length === 0) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.BAD_REQUEST, 'No family in this audience can receive an SMS');
    }
    if (a.recipients.length !== dto.expectedRecipients) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT,
        `The audience changed: it now reaches ${a.recipients.length} families, not ${dto.expectedRecipients}. Check it again before sending.`);
    }
    const segmentsPerMessage = computeSegments(dto.body).segments;
    const totalSegments = segmentsPerMessage * a.recipients.length;
    const balance = await this.credits.balance();
    if (balance < totalSegments) {
      throw new AppError(ErrorCodes.INSUFFICIENT_SMS_CREDITS, HttpStatus.CONFLICT,
        `This needs ${totalSegments} SMS credits and the school has ${balance}. Nothing was sent.`);
    }
    const schoolId = this.ctx.requireSchoolId();
    // Audit first: the queue sits outside the transaction, so if the audit write fails nothing is queued.
    await this.audit.record({
      action: AuditActions.SMS_BROADCAST_SENT,
      entityType: 'SmsBroadcast',
      entityId: schoolId,
      newValue: {
        audience: { campusId: effectiveCampusFilter(this.ctx.user, dto.campusId) ?? null, classId: dto.classId ?? null, sectionId: dto.sectionId ?? null },
        recipients: a.recipients.length, skipped: a.skipped, totalSegments, body: dto.body,
      },
    });
    for (const recipients of chunk(a.recipients, 100)) {
      await this.producer.enqueueManual({ type: 'MANUAL', schoolId, recipients, body: dto.body });
    }
    return { queued: a.recipients.length, skipped: a.skipped, totalSegments };
  }

  async retry(logId: string): Promise<void> {
    const log = await this.db.smsLog.findFirst({ where: { id: logId } });
    if (!log) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'SMS log not found');
    if (log.status !== SmsStatus.FAILED) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Only failed messages can be retried');
    }
    // ⚠️ A withheld message's stored body is the placeholder "(withheld: …)", not what was meant to be sent —
    // retrying it texted that placeholder to the parent. And the reason it was withheld has not gone away.
    if (log.failReason === ErrorCodes.SMS_OPTED_OUT || log.failReason === ErrorCodes.PHONE_UNVERIFIED) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT,
        log.failReason === ErrorCodes.SMS_OPTED_OUT
          ? 'This parent opted out of SMS, so the message cannot be retried'
          : "This number is not verified. Verify the guardian's phone first");
    }
    await this.producer.enqueueManual({
      type: 'MANUAL',
      schoolId: this.ctx.requireSchoolId(),
      recipients: [log.recipient],
      body: log.message,
    });
  }

  // ── Delivery webhook (public, HMAC — no tenant context) ──────────────────────
  async handleWebhook(signature: string | undefined, dto: SmsWebhookDto): Promise<void> {
    const expected = createHmac('sha256', this.env.SMS_WEBHOOK_HMAC_SECRET)
      .update(`${dto.gatewayMessageId}.${dto.status}`)
      .digest('hex');
    if (!signature || !safeEqualHex(signature, expected)) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Invalid webhook signature');
    }
    // Cross-tenant lookup by gatewayMessageId → platform (BYPASSRLS) client.
    const log = await this.platform.smsLog.findFirst({ where: { gatewayMessageId: dto.gatewayMessageId } });
    if (!log) return; // unknown id — ack silently
    await this.platform.smsLog.update({
      where: { id: log.id },
      data: {
        status: dto.status as SmsStatus,
        failReason: dto.status === 'FAILED' ? (dto.failReason ?? 'GATEWAY_FAILED') : null,
        deliveredAt: dto.status === 'DELIVERED' ? new Date() : log.deliveredAt,
      },
    });
  }
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
