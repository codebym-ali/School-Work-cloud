import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { bullConnection, ENV, type Env } from '@common';
import { MaintenanceService, type MaintenanceJob } from '../maintenance/maintenance.service';

const QUEUE = 'maintenance';

/**
 * Schedules + consumes the nightly cross-tenant maintenance jobs (blueprint §27) on a
 * BullMQ **repeatable** queue. The repeat schedulers are upserted on boot (idempotent),
 * so exactly one fleet-wide fire happens per window regardless of how many worker
 * replicas run. Times are cron in the server TZ (set TZ=Asia/Karachi in prod).
 */
@Injectable()
export class MaintenanceProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaintenanceProcessor.name);
  private worker?: Worker;
  private queue?: Queue;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly maintenance: MaintenanceService,
  ) {}

  async onModuleInit(): Promise<void> {
    const connection = bullConnection(this.env.REDIS_URL);
    this.queue = new Queue(QUEUE, { connection });

    // Idempotent schedules — BullMQ dedupes repeatables by their repeat key.
    const opts = { removeOnComplete: true as const, removeOnFail: 100 };
    await this.queue.add('mark-overdue', {}, { repeat: { pattern: '0 1 * * *' }, ...opts });
    await this.queue.add('fee-integrity-check', {}, { repeat: { pattern: '30 1 * * *' }, ...opts });
    await this.queue.add('idempotency-purge', {}, { repeat: { pattern: '0 * * * *' }, ...opts }); // hourly
    await this.queue.add('sms-log-purge', {}, { repeat: { pattern: '0 2 * * *' }, ...opts }); // nightly 02:00

    this.worker = new Worker(
      QUEUE,
      (job) => this.maintenance.run(job.name as MaintenanceJob),
      { connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => this.logger.error(`maintenance "${job?.name}" failed: ${err.message}`));
    this.logger.log('Maintenance processor listening on queue "maintenance" (nightly schedules registered)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
