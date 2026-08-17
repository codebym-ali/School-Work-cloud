import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class TimetableQuery {
  /** Defaults to the school's current academic year. */
  @IsOptional() @IsUUID()
  academicYearId?: string;
}

export class SetSlotDto {
  @IsUUID()
  sectionId!: string;

  @IsOptional() @IsUUID()
  academicYearId?: string;

  /** 1 = Monday … 7 = Sunday, matching the stored column. A school that works Saturdays simply
   *  fills day 6; nothing here decides which days a school teaches on. */
  @Type(() => Number) @IsInt() @Min(1) @Max(7)
  dayOfWeek!: number;

  /** Bounded at 12 to catch a typo, not to express a rule — no school runs 40 periods, and an
   *  unbounded integer here would let one bad keystroke create a grid nobody can render. */
  @Type(() => Number) @IsInt() @Min(1) @Max(12)
  periodNo!: number;

  @IsUUID()
  subjectId!: string;

  @IsUUID()
  staffId!: string;

  @IsOptional() @IsString() @MaxLength(40)
  room?: string;
}

/**
 * Copy one day's lessons onto others.
 *
 * ⚠️ **Copying to a sibling SECTION is deliberately not here.** Two sections of one class running the
 * same grid clash on the same teacher at *every* row — that is the normal outcome, not an edge case
 * — and `TimetableSlot.staffId` is NOT NULL, so there is no "copy the subjects, leave the teachers
 * blank" escape without a schema change reaching attendance and cover. It needs its own decision.
 */
export class CopyDayDto {
  @IsUUID()
  sectionId!: string;

  @IsOptional() @IsUUID()
  academicYearId?: string;

  @Type(() => Number) @IsInt() @Min(1) @Max(7)
  fromDay!: number;

  /** At most six, because there are only six other days. */
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(6)
  @Type(() => Number) @IsInt({ each: true }) @Min(1, { each: true }) @Max(7, { each: true })
  toDays!: number[];
}
