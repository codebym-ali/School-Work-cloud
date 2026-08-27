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
    await this.queue.add('sms-monthly-credit', {}, { repeat: { pattern: '30 0 1 * *' }, ...opts }); // 1st of month 00:30
    // Day close — an HOURLY TICK, not a fixed hour (G2). The close time is per school
    // (`staffAttendance.closeAtTime`), so the job wakes every hour and settles only the schools
    // whose own local close time has passed and which have not been closed today.
    //
    // A single fleet-wide 20:00 meant a morning school ending at 13:00 waited seven hours, and a
    // teacher who arrived after the close could not check in at all — their ABSENT row already
    // existed. Safe to run hourly because the job is idempotent by construction: it never touches
    // a row that exists, so the passes after the first write nothing.
    //
    // Still a no-op for every school that hasn't opted in (`staffAttendance.autoMarkAbsent`),
    // which is all of them by default: this is the only job that writes payroll-affecting rows
    // with nobody pressing anything.
    await this.queue.add('staff-attendance-close', {}, { repeat: { pattern: '0 * * * *' }, ...opts });
    // Fleet snapshot for the vendor dashboard (SA1) — nightly at 00:15, ahead of the fee jobs at
    // 01:00. A handful of indexed COUNTs on the BYPASSRLS connection; the dashboard reads the latest
    // row, so a page load never runs a fleet-wide COUNT across every school × student (SA-P7 / finding E).
    await this.queue.add('platform-stats-snapshot', {}, { repeat: { pattern: '15 0 * * *' }, ...opts });
    // Vendor billing (SA6b). Auto-invoice on the 1st at 01:30 (after the SMS credit grant at 00:30) —
    // generates each priced, active school's monthly invoice, idempotent per (school, month). Dunning
    // runs DAILY at 02:30 — auto-suspends any school with a vendor invoice unpaid past the grace window.
    await this.queue.add('platform-billing-run', {}, { repeat: { pattern: '30 1 1 * *' }, ...opts });
    await this.queue.add('platform-dunning', {}, { repeat: { pattern: '30 2 * * *' }, ...opts });

    this.worker = new Worker(
      QUEUE,
      (job) => this.maintenance.run(job.name as MaintenanceJob),
      { connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => this.logger.error(`maintenance "${job?.name}" failed: ${err.message}`));
    // BullMQ emits 'error' for internal issues (e.g. an expired lock after the process was
    // suspended) that aren't tied to a specific job. Without a listener, Node treats an
    // unhandled 'error' event as fatal and kills the process — so this must stay wired up.
    this.worker.on('error', (err) => this.logger.error(`maintenance worker error: ${err.message}`));
    this.logger.log('Maintenance processor listening on queue "maintenance" (nightly schedules registered)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
