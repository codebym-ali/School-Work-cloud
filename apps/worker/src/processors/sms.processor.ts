import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { bullConnection, captureError, CLS_KEYS, ENV, flushSentry, type Env } from '@common';
import { TenantPrismaService } from '@database';
import { SmsService } from '../../../api/src/modules/comms/sms/sms.service';
import { SMS_QUEUE_NAME, type SmsJob } from '../../../api/src/modules/comms/sms/sms.types';

/**
 * BullMQ consumer for the 'sms' queue (blueprint §27). Each job runs inside a fresh
 * CLS context bound to the job's schoolId and a withTenant transaction, so the
 * dispatch logic is RLS-scoped exactly like a request. attempts:3 + backoff come
 * from the queue's defaultJobOptions; exhausted jobs stay on the failed set for the
 * failed-messages screen.
 */
@Injectable()
export class SmsProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SmsProcessor.name);
  private worker?: Worker;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly cls: ClsService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly sms: SmsService,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker(
      SMS_QUEUE_NAME,
      async (job) => {
        const data = job.data as SmsJob;
        await this.cls.run(async () => {
          this.cls.set(CLS_KEYS.schoolId, data.schoolId);
          await this.tenantPrisma.withTenant(() => this.sms.dispatch(data));
        });
      },
      { connection: bullConnection(this.env.REDIS_URL), concurrency: 10 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.warn(`SMS job ${job?.id} failed: ${err.message}`);
      // Only the final attempt (exhausted retries) is worth alerting on (§27, §31).
      if (!job || job.attemptsMade >= (job.opts.attempts ?? 1)) {
        captureError(err, {
          queue: SMS_QUEUE_NAME,
          jobId: job?.id,
          schoolId: (job?.data as SmsJob | undefined)?.schoolId,
        });
      }
    });
    // BullMQ emits 'error' for internal issues (e.g. an expired lock after the process was
    // suspended) that aren't tied to a specific job. Without a listener, Node treats an
    // unhandled 'error' event as fatal and kills the process — so this must stay wired up.
    this.worker.on('error', (err) => this.logger.error(`SMS worker error: ${err.message}`));
    this.logger.log('SMS processor listening on queue "sms"');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await flushSentry();
  }
}
