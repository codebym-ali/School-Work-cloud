import { IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';
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

/** Who a broadcast goes to. Omit everything for the whole school (a campus-bound caller is forced to theirs). */
export class BroadcastAudienceDto {
  @IsOptional() @IsUUID() campusId?: string;
  @IsOptional() @IsUUID() classId?: string;
  @IsOptional() @IsUUID() sectionId?: string;

  // Four segments of plain text. A broadcast longer than that is a letter, and costs like one.
  @IsString() @MinLength(1) @MaxLength(612)
  body!: string;
}

export class BroadcastSendDto extends BroadcastAudienceDto {
  /**
   * The family count the sender was SHOWN. If the audience changed between preview and send (a class
   * admitted ten students), the send is refused so nobody pays for a number they did not agree to.
   */
  @IsInt() @Min(1)
  expectedRecipients!: number;
}

export class SmsLogQuery extends PaginationQuery {
  @IsOptional() @IsIn(['QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'WITHHELD'])
  status?: 'QUEUED' | 'SENT' | 'DELIVERED' | 'FAILED' | 'WITHHELD';

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
