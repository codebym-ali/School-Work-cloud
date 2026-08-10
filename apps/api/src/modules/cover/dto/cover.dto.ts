import { IsDateString, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CoverQuery {
  /** Defaults to today — the day the office is standing in. */
  @IsOptional() @IsDateString()
  date?: string;
}

export class CreateCoverDto {
  @IsUUID()
  sectionId!: string;

  @IsDateString()
  date!: string;

  @IsUUID()
  coveringStaffId!: string;

  /**
   * Omit for "all day", which is the only thing a school without a timetable can mean. Bounded at
   * 12 to catch a typo rather than to express a rule.
   */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(12)
  periodNo?: number;

  /** Who is away. Optional: a class can need someone for reasons the register does not know. */
  @IsOptional() @IsUUID()
  absentStaffId?: string;

  @IsOptional() @IsString() @MaxLength(200)
  reason?: string;
}
