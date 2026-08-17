import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** Local wall clock, zero-padded. Same shape as `attendanceMarkByTime` and `dayStartTime`. */
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class BellScheduleQuery {
  /** Defaults to the school's current academic year. */
  @IsOptional() @IsUUID()
  academicYearId?: string;

  @IsOptional() @IsUUID()
  campusId?: string;
}

export class CreateBellScheduleDto {
  @IsUUID()
  campusId!: string;

  @IsOptional() @IsUUID()
  academicYearId?: string;

  @IsString() @MaxLength(60)
  name!: string;

  /**
   * The campus fallback. A campus may have one per year; every class not named on a wing schedule
   * follows it.
   */
  @IsOptional() @IsBoolean()
  isDefault?: boolean;

  /** Wing override (P4): the classes that follow this schedule instead of the campus default. */
  @IsOptional() @IsArray() @IsUUID(undefined, { each: true }) @ArrayMaxSize(200)
  classIds?: string[];
}

export class UpdateBellScheduleDto {
  @IsOptional() @IsString() @MaxLength(60)
  name?: string;

  /** Replaces the whole list. Omit to leave the attachment alone. */
  @IsOptional() @IsArray() @IsUUID(undefined, { each: true }) @ArrayMaxSize(200)
  classIds?: string[];
}

/**
 * One row of a composed day.
 *
 * ⚠️ **No times here, deliberately.** The client sends a duration and the server walks the day from
 * its start, so a gap or an overlap between rows is not rejected — there is no way to express one.
 * `sequence` and `periodNo` are assigned for the same reason: a hand-typed period number is how a
 * grid ends up with a period 7 that no bell rings for.
 */
export class BellDayRowDto {
  @IsBoolean()
  isTeaching!: boolean;

  /** "Break", "Lunch", "Assembly", "Jumma". Teaching rows are named by their number. */
  @IsOptional() @IsString() @MaxLength(30)
  label?: string;

  /** Bounded to catch a typo, not to express a rule — 240 is already a four-hour period. */
  @Type(() => Number) @IsInt() @Min(1) @Max(240)
  minutes!: number;
}

export class SetBellDayDto {
  /** When the first row of this day begins, local wall clock. */
  @Matches(HH_MM, { message: 'startsAt must be HH:MM (24-hour)' })
  startsAt!: string;

  /**
   * The whole day, in order. An empty list is meaningful — it clears the day, which is how a school
   * says "we do not teach on Sunday".
   */
  @IsArray() @ValidateNested({ each: true }) @Type(() => BellDayRowDto) @ArrayMaxSize(24)
  rows!: BellDayRowDto[];
}
