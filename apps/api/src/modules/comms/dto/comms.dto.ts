import { IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PaginationQuery } from '@common';
import { SMS_TRIGGER_KEYS, type SmsTriggerKey } from '../sms/sms-templates.defaults';

export class UpsertTemplateDto {
  @IsIn(SMS_TRIGGER_KEYS as unknown as string[])
  triggerKey!: SmsTriggerKey;

  @IsString() @MaxLength(1000)
  body!: string;
}

export class ManualSendDto {
  @IsArray()
  @IsString({ each: true })
  recipients!: string[]; // normalized phone numbers

  @IsString() @MinLength(1) @MaxLength(1000)
  body!: string;
}

export class SmsLogQuery extends PaginationQuery {
  @IsOptional() @IsIn(['QUEUED', 'SENT', 'DELIVERED', 'FAILED'])
  status?: 'QUEUED' | 'SENT' | 'DELIVERED' | 'FAILED';

  @IsOptional() @IsString()
  templateKey?: string;
}

export class SmsWebhookDto {
  @IsString()
  gatewayMessageId!: string;

  @IsIn(['SENT', 'DELIVERED', 'FAILED'])
  status!: 'SENT' | 'DELIVERED' | 'FAILED';

  @IsOptional() @IsString()
  failReason?: string;
}
