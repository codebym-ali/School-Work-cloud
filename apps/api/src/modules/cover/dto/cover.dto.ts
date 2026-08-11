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

/** Who could take this class (Cover Plan, C3). `periodNo` sharpens the answer; without it the
 *  question is only "who is in school today", and the response says so rather than implying more. */
export class CoverSuggestionQuery {
  @IsUUID()
  sectionId!: string;

  @IsOptional() @IsDateString()
  date?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(12)
  periodNo?: number;
}

/**
 * The same cover, repeated over a known multi-day absence (Cover Plan, C1).
 *
 * A separate endpoint rather than a `toDate` on `CreateCoverDto`, because it does not behave like
 * a create: some days in a range are legitimately skipped (weekly off, a closure, a day already
 * covered), so it answers with a summary instead of a row, the way `/attendance/bulk` does.
 */
export class CreateCoverRangeDto {
  @IsUUID()
  sectionId!: string;

  @IsDateString()
  fromDate!: string;

  @IsDateString()
  toDate!: string;

  @IsUUID()
  coveringStaffId!: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(12)
  periodNo?: number;

  @IsOptional() @IsUUID()
  absentStaffId?: string;

  @IsOptional() @IsString() @MaxLength(200)
  reason?: string;
}
