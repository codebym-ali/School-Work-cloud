import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
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
}
