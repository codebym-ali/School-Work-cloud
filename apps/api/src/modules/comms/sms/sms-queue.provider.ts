import { Queue } from 'bullmq';
import { bullConnection, ENV, type Env } from '@common';
import { SMS_QUEUE, SMS_QUEUE_NAME } from './sms.types';

/**
 * BullMQ 'sms' queue (blueprint §27). The API is the producer; the worker
 * deployable consumes it. Default job options: 3 attempts with exponential backoff,
 * then dead-letter (kept for the failed-messages screen).
 */
export const smsQueueProvider = {
  provide: SMS_QUEUE,
  inject: [ENV],
  useFactory: (env: Env): Queue => {
    return new Queue(SMS_QUEUE_NAME, {
      connection: bullConnection(env.REDIS_URL),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: false,
      },
    });
  },
};
