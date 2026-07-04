import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { CommonModule, RedisModule } from '@common';
import { DatabaseModule } from '@database';

/**
 * Background worker composition root (blueprint §16, §27). Shares the codebase with
 * the API. BullMQ queue processors are added per milestone (absence-sms, mark-overdue,
 * report-cards-generate, …); each opens its own withTenant per unit of work (§21.4).
 */
@Module({
  imports: [
    ClsModule.forRoot({ global: true }),
    CommonModule,
    RedisModule,
    DatabaseModule,
  ],
})
export class WorkerModule {}
