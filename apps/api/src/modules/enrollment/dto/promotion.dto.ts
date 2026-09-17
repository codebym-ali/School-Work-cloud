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

/**
 * Plan a promotion over a CAMPUS (default) or named sections. A campus-bound caller is forced to their own
 * campus in the service whatever is sent.
 */
export class PromotionPlanDto {
  @IsUUID() targetYearId!: string;

  @IsOptional() @IsUUID()
  campusId?: string;

  @IsOptional() @IsArray() @IsUUID('4', { each: true })
  sectionIds?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PromotionOverrideDto)
  overrides?: PromotionOverrideDto[];

  /** OWNER_ADMIN only (enforced in the service): promote students who still owe fees. */
  @IsOptional() @IsBoolean()
  overridePreconditions?: boolean;
}

/** Commit exactly the plan that was previewed — refused if its fingerprint no longer matches. */
export class PromotionCommitDto extends PromotionPlanDto {
  @IsString() @MaxLength(64)
  fingerprint!: string;

  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
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
