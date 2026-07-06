import { Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '@common';

export interface SendResult {
  gatewayMessageId: string;
  accepted: boolean;
  error?: string;
}

/**
 * Pluggable SMS gateway (blueprint §26): a single interface with provider-specific
 * adapters behind it, so we can swap Telenor/Jazz aggregators without touching call
 * sites. v1 ships the `console` adapter (logs + returns a synthetic id) for dev;
 * real provider adapters land when the aggregator contract is signed (§35).
 */
export interface SmsGateway {
  send(to: string, message: string): Promise<SendResult>;
}

export const SMS_GATEWAY = Symbol('SMS_GATEWAY');

@Injectable()
export class ConsoleSmsGateway implements SmsGateway {
  private readonly logger = new Logger('ConsoleSmsGateway');

  async send(to: string, message: string): Promise<SendResult> {
    const gatewayMessageId = `console-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.logger.debug(`SMS -> ${to}: ${message} [${gatewayMessageId}]`);
    return { gatewayMessageId, accepted: true };
  }
}

/** Selects the adapter from SMS_PROVIDER; only `console` is implemented in v1. */
export function smsGatewayFactory(env: Env): SmsGateway {
  switch (env.SMS_PROVIDER) {
    case 'console':
      return new ConsoleSmsGateway();
    default:
      // telenor/jazz adapters are added with the aggregator contract (§35).
      new Logger('SmsGateway').warn(`Provider "${env.SMS_PROVIDER}" not implemented — using console`);
      return new ConsoleSmsGateway();
  }
}

export const smsGatewayProvider = {
  provide: SMS_GATEWAY,
  inject: [ENV],
  useFactory: (env: Env) => smsGatewayFactory(env),
};
