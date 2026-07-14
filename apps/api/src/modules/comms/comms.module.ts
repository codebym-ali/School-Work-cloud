import { Module } from '@nestjs/common';
import { CommsService } from './comms.service';
import { SmsController, SmsWebhookController } from './comms.controller';
import { SmsService } from './sms/sms.service';
import { CreditsService } from './sms/credits.service';
import { SmsProducer } from './sms/sms-producer.service';
import { smsQueueProvider } from './sms/sms-queue.provider';
import { smsGatewayProvider } from './sms/sms-gateway';

/**
 * Communications (blueprint §14, §26). Provides the SMS send pipeline (SmsService),
 * the credit ledger, the BullMQ producer/queue, and the pluggable gateway.
 * SmsService + SmsProducer are exported so attendance/leaves can notify, and the
 * worker can run dispatch.
 */
@Module({
  controllers: [SmsController, SmsWebhookController],
  providers: [
    CommsService,
    SmsService,
    CreditsService,
    SmsProducer,
    smsQueueProvider,
    smsGatewayProvider,
  ],
  exports: [SmsService, SmsProducer, CreditsService, smsQueueProvider, smsGatewayProvider],
})
export class CommsModule {}
