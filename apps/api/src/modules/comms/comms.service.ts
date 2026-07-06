import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { SmsStatus } from '@prisma/client';
import {
  AppError,
  ENV,
  ErrorCodes,
  paginate,
  TenantContext,
  toSkipTake,
  type Env,
  type Paginated,
} from '@common';
import { PlatformPrismaService, TenantPrismaService } from '@database';
import { CreditsService } from './sms/credits.service';
import { SmsProducer } from './sms/sms-producer.service';
import { computeSegments } from './sms/sms-segments';
import { DEFAULT_TEMPLATES, SMS_TRIGGER_KEYS } from './sms/sms-templates.defaults';
import type { ManualSendDto, SmsLogQuery, SmsWebhookDto, UpsertTemplateDto } from './dto/comms.dto';

/** API-facing comms operations (blueprint §14, §24): templates, logs, credits, manual send, webhooks. */
@Injectable()
export class CommsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly platform: PlatformPrismaService,
    private readonly ctx: TenantContext,
    private readonly credits: CreditsService,
    private readonly producer: SmsProducer,
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

  async retry(logId: string): Promise<void> {
    const log = await this.db.smsLog.findFirst({ where: { id: logId } });
    if (!log) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'SMS log not found');
    if (log.status !== SmsStatus.FAILED) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Only failed messages can be retried');
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
