import { Inject, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { SMS_QUEUE, type SmsJob } from './sms.types';

/**
 * Enqueues SMS jobs (blueprint §26). Event-driven per-key idempotency uses the
 * BullMQ jobId so a re-submitted attendance batch cannot double-send an absence SMS.
 */
@Injectable()
export class SmsProducer {
  constructor(@Inject(SMS_QUEUE) private readonly queue: Queue) {}

  /** key absence:{enrollmentId}:{date} — dedups re-submissions (§9). */
  async enqueueAbsence(job: Extract<SmsJob, { type: 'ABSENCE' }>): Promise<void> {
    await this.queue.add('ABSENCE', job, { jobId: `absence:${job.enrollmentId}:${job.date}` });
  }

  async enqueueLeaveStatus(job: Extract<SmsJob, { type: 'LEAVE_STATUS' }>): Promise<void> {
    await this.queue.add('LEAVE_STATUS', job);
  }

  /** key receipt:{invoiceId}:{receiptNo} — dedups accidental re-enqueue of a receipt. */
  async enqueueReceipt(job: Extract<SmsJob, { type: 'FEE_RECEIPT' }>): Promise<void> {
    await this.queue.add('FEE_RECEIPT', job, { jobId: `receipt:${job.invoiceId}:${job.receiptNo}` });
  }

  async enqueueResultReady(job: Extract<SmsJob, { type: 'RESULT_READY' }>): Promise<void> {
    await this.queue.add('RESULT_READY', job);
  }

  async enqueueManual(job: Extract<SmsJob, { type: 'MANUAL' }>): Promise<void> {
    await this.queue.add('MANUAL', job);
  }
}
