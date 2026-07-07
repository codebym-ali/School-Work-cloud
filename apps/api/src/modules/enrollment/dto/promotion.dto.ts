import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class PromotionOverrideDto {
  @IsUUID() studentId!: string;

  @IsIn(['RETAINED', 'WITHDRAWN'])
  action!: 'RETAINED' | 'WITHDRAWN';
}

export class PromoteDto {
  @IsUUID() sectionId!: string;
  @IsUUID() targetYearId!: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PromotionOverrideDto)
  overrides?: PromotionOverrideDto[];

  /** OWNER_ADMIN: bypass fee-clearance/report-card preconditions (audited). */
  @IsOptional() @IsBoolean()
  overridePreconditions?: boolean;

  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}
