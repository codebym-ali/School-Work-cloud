import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AttendanceSession, AttendanceStatus } from '@prisma/client';

export class AttendanceRecordInput {
  @IsUUID()
  enrollmentId!: string;

  @IsEnum(AttendanceStatus)
  status!: AttendanceStatus;
}

export class MarkAttendanceDto {
  @IsUUID()
  sectionId!: string;

  @IsDateString()
  date!: string;

  @IsEnum(AttendanceSession)
  session!: AttendanceSession;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AttendanceRecordInput)
  records!: AttendanceRecordInput[];

  /** Admin-only: mark on a holiday/weekly-off day (audited). */
  @IsOptional() @IsBoolean()
  allowHolidayOverride?: boolean;
}

/** Query behind the backfill completeness strip: the last `days` days for one section. */
export class AttendanceCoverageQuery {
  @IsUUID() sectionId!: string;
  @IsEnum(AttendanceSession) session!: AttendanceSession;
  /** Kept small on purpose — the strip exists to show the backfill window, not history. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(31)
  days?: number;
}

export class AttendanceQuery {
  @IsOptional() @IsUUID()
  sectionId?: string;

  @IsOptional() @IsDateString()
  date?: string;

  @IsOptional() @IsUUID()
  studentId?: string;

  @IsOptional() @IsDateString()
  from?: string;

  @IsOptional() @IsDateString()
  to?: string;
}

export class PatchAttendanceDto {
  @IsEnum(AttendanceStatus)
  status!: AttendanceStatus;

  @IsString() @MinLength(1) @MaxLength(500)
  reason!: string;
}

// ── Staff attendance ─────────────────────────────────────────────────────────
export class StaffAttendanceRecordInput {
  @IsUUID()
  staffId!: string;

  @IsEnum(AttendanceStatus)
  status!: AttendanceStatus;
}

export class MarkStaffAttendanceDto {
  @IsDateString()
  date!: string;

  @IsEnum(AttendanceSession)
  session!: AttendanceSession;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => StaffAttendanceRecordInput)
  records!: StaffAttendanceRecordInput[];

  /** Mark on a holiday/weekly-off day. Admin-only endpoint, so no extra role check is needed. */
  @IsOptional() @IsBoolean()
  allowHolidayOverride?: boolean;

  /** Why — carried onto the row and into the audit entry when overriding a self-marked day. */
  @IsOptional() @IsString() @MaxLength(200)
  note?: string;
}

/**
 * The caller's own attendance over a range. Note there is deliberately **no `staffId`** — the
 * person is resolved from the session, so reading a colleague's record is not a permission
 * that could be misconfigured, it is unexpressible.
 */
export class MyStaffAttendanceQuery {
  @IsOptional() @IsDateString()
  from?: string;

  @IsOptional() @IsDateString()
  to?: string;
}

/** `status` accepts the attendance statuses plus `UNMARKED` — the register's whole point is
 *  that "nobody has said" is a filterable state, not the absence of one. */
export class StaffRegisterQuery {
  @IsOptional() @IsDateString()
  date?: string;

  @IsOptional() @IsIn([...Object.values(AttendanceStatus), 'UNMARKED'])
  status?: string;

  @IsOptional() @IsUUID()
  campusId?: string;
}

export class StaffHistoryQuery {
  /** Absent ⇒ from the day they joined, so "all time" is a real answer. */
  @IsOptional() @IsDateString()
  from?: string;

  @IsOptional() @IsDateString()
  to?: string;
}
