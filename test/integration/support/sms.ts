import type { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { CLS_KEYS } from '@common';
import { TenantPrismaService } from '@database';
import { SmsService } from '../../../apps/api/src/modules/comms/sms/sms.service';
import { SMS_QUEUE } from '../../../apps/api/src/modules/comms/sms/sms.types';

/**
 * Dispatch a school's queued SMS in-process, standing in for the worker.
 *
 * This lived as three hand-copied helpers (attendance, exams, fees) and the same two bugs were
 * fixed in one copy at a time while the others kept failing, so it is one function now.
 *
 * Two rules the copies got wrong, both stemming from the same fact — **the `sms` queue is shared
 * across the whole Redis instance**, so it holds jobs from other tenants (another spec in the
 * same run, or a leftover from an interrupted one):
 *
 * 1. **Only touch our own jobs, and dispatch each under ITS OWN `schoolId`.** Forcing the calling
 *    spec's tenant onto every job re-attributes another school's message to this one, corrupting
 *    both specs' log assertions — and then deletes it out from under the spec that queued it.
 *    Mirrors how the real worker resolves the tenant (`sms.processor.ts`).
 *
 * 2. **A job we cannot remove is not a test failure.** `active` jobs are locked, and any worker
 *    attached to the same Redis (this machine respawns `start:worker:dev`) holds that lock. That
 *    is a fact about the environment, not about attendance or fees or exams, and a helper should
 *    not fail the suite over queue state it does not own. The job is left for its lock-holder.
 *
 * Note the double-dispatch risk that remains: a live dev worker races this helper and may deliver
 * a message before we do. `test/integration/support/no-worker.js` is the guard for that.
 *
 * @returns how many of OUR jobs were dispatched — some specs assert on the count.
 */
export async function drainSmsFor(app: INestApplication, schoolId: string): Promise<number> {
  const queue = app.get<Queue>(SMS_QUEUE, { strict: false });
  const cls = app.get(ClsService);
  const tenantPrisma = app.get(TenantPrismaService);
  const sms = app.get(SmsService, { strict: false });

  const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'prioritized']);
  const mine = jobs.filter((j) => (j.data as { schoolId?: string })?.schoolId === schoolId);

  for (const job of mine) {
    await cls.run(async () => {
      cls.set(CLS_KEYS.schoolId, (job.data as { schoolId: string }).schoolId);
      await tenantPrisma.withTenant(() => sms.dispatch(job.data));
    });
    await job.remove().catch(() => undefined);
  }
  return mine.length;
}
