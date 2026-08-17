import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

// ── Academic years ───────────────────────────────────────────────────────────
export class CreateAcademicYearDto {
  @IsString() @MinLength(1) @MaxLength(32)
  name!: string; // "2026-27"

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsOptional() @IsBoolean()
  isCurrent?: boolean;
}

// ── Campuses ─────────────────────────────────────────────────────────────────
export class CreateCampusDto {
  @IsString() @MinLength(1) @MaxLength(120)
  name!: string;

  @IsOptional() @IsString() @MaxLength(500)
  address?: string;
}

export class UpdateCampusDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  name?: string;

  @IsOptional() @IsString() @MaxLength(500)
  address?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

// ── Classes ──────────────────────────────────────────────────────────────────
export class CreateClassDto {
  @IsUUID()
  campusId!: string;

  @IsString() @MinLength(1) @MaxLength(80)
  name!: string; // "Grade 5"

  @IsInt() @Min(0)
  order!: number; // Nursery=0, Grade1=1 …

  @IsOptional() @IsInt() @Min(2) @Max(30)
  minAgeYears?: number;

  @IsOptional() @IsInt() @Min(2) @Max(30)
  maxAgeYears?: number;
}

// ── Sections ─────────────────────────────────────────────────────────────────
export class CreateSectionDto {
  @IsUUID()
  classId!: string;

  @IsString() @MinLength(1) @MaxLength(40)
  name!: string; // "A"

  @IsOptional() @IsInt() @Min(1) @Max(200)
  capacity?: number;

  /** Copy the subject list from an existing section of the same class ("same as Section A").
   *  Ignored when `subjectIds` is given. */
  @IsOptional() @IsUUID()
  copySubjectsFromSectionId?: string;

  /** The subjects this section studies, chosen from its class's catalogue. Omit both this
   *  and the copy field and the section studies everything the class offers. */
  @IsOptional() @IsArray() @IsUUID(undefined, { each: true })
  subjectIds?: string[];
}

export class UpdateClassDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsInt() @Min(2) @Max(30) minAgeYears?: number;
  @IsOptional() @IsInt() @Min(2) @Max(30) maxAgeYears?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1000) order?: number;
}

export class UpdateSectionDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(40) name?: string;
  @IsOptional() @IsInt() @Min(1) @Max(200) capacity?: number;
}

export class UpdateSubjectDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;

  /** Weekly load. `null` clears it — "not allocated" is a real state, distinct from zero. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(60) periodsPerWeek?: number | null;
}

export class SetSectionSubjectsDto {
  @IsArray() @IsUUID(undefined, { each: true })
  subjectIds!: string[];
}

// ── Subjects ─────────────────────────────────────────────────────────────────
export class CreateSubjectDto {
  @IsUUID()
  classId!: string;

  @IsString() @MinLength(1) @MaxLength(80)
  name!: string;

  /** How many periods a week this subject should get. Advisory — nothing is ever refused on it. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(60)
  periodsPerWeek?: number;
}

// ── Holidays / closures ──────────────────────────────────────────────────────
export class CreateHolidayDto {
  @IsDateString()
  date!: string;

  /**
   * Required, and required for a reason: the screens are built to render
   * "{holidayName} — no register today". "Holiday" tells a teacher nothing about why the gate
   * is locked, and a closure with no reason is indistinguishable from a mistake.
   */
  @IsString() @MinLength(2) @MaxLength(120)
  name!: string;

  /** Omitted ⇒ the whole school. Only an owner may omit it; a campus admin is forced to theirs. */
  @IsOptional() @IsUUID()
  campusId?: string;
}

/** Winter break in one action rather than fourteen clicks. Inclusive of both ends. */
export class CreateHolidayRangeDto {
  @IsDateString() fromDate!: string;
  @IsDateString() toDate!: string;

  @IsString() @MinLength(2) @MaxLength(120)
  name!: string;

  @IsOptional() @IsUUID()
  campusId?: string;
}

export class HolidayListQuery {
  /** Defaults to the current academic year in the service — a calendar without a period is noise. */
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsUUID() campusId?: string;
}

// ── List filters ─────────────────────────────────────────────────────────────
export class ClassListQuery {
  @IsOptional() @IsUUID()
  campusId?: string;
}

export class SectionListQuery {
  @IsOptional() @IsUUID()
  classId?: string;
}

// ── School settings ──────────────────────────────────────────────────────────
class StaffAttendanceSettingsDto {
  @IsOptional() @IsBoolean() selfMarking?: boolean;
  @IsOptional() @IsBoolean() autoMarkAbsent?: boolean;
  @IsOptional() @IsString() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'dayStartTime must be HH:MM' })
  dayStartTime?: string;
  @IsOptional() @IsInt() @Min(0) @Max(120) graceMinutes?: number;
  @IsOptional() @IsString() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'closeAtTime must be HH:MM' })
  closeAtTime?: string;
}

class FeeSubmissionSettingsDto {
  @IsOptional() @IsArray() @ArrayMinSize(1, { message: 'Accept at least one payment method' })
  @IsIn(['CASH', 'BANK_TRANSFER', 'EASYPAISA', 'JAZZCASH', 'CHEQUE', 'CARD'], { each: true })
  methods?: string[];

  @IsOptional() @IsIn(['OFF', 'OPTIONAL', 'REQUIRED']) proofPolicy?: string;
  @IsOptional() @IsBoolean() guardianUploadLink?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(30) chequeClearingDays?: number;
}

class StaffLeaveQuotasDto {
  @IsOptional() @IsInt() @Min(0) CASUAL?: number;
  @IsOptional() @IsInt() @Min(0) SICK?: number;
  @IsOptional() @IsInt() @Min(0) UNPAID?: number;
  @IsOptional() @IsInt() @Min(0) OTHER?: number;
}

/**
 * A PARTIAL change to the school's settings — send only what moves.
 *
 * This mirrors the Zod schema in `libs/common` rather than replacing it: class-validator gives
 * the request a 400 with a field name, and the service then validates the MERGED object with
 * Zod, which is the single source of truth for what a valid settings blob is. Two layers on
 * purpose — the DTO rejects nonsense shapes early, Zod rejects invalid combinations.
 */
export class UpdateSchoolSettingsDto {
  /** IANA zone name. The Zod schema is the real validator — it asks the runtime to resolve it. */
  @IsOptional() @IsString() @MaxLength(64)
  timezone?: string;

  @IsOptional() @IsArray() @IsIn(['MORNING', 'EVENING'], { each: true })
  attendanceSessions?: string[];

  @IsOptional() @IsArray()
  @IsIn(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'], { each: true })
  weeklyOffDays?: string[];

  @IsOptional() @IsInt() @Min(0) @Max(90) attendanceEditWindowDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(90) attendanceBackfillDays?: number;
  @IsOptional() @IsString() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'attendanceMarkByTime must be HH:MM' })
  attendanceMarkByTime?: string;
  @IsOptional() @IsBoolean() allowHolidayOverride?: boolean;

  @IsOptional() @IsInt() @Min(1) @Max(28) feeDueDay?: number;
  @IsOptional() @IsIn(['FULL', 'HALF', 'DAILY']) midMonthProration?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) siblingDiscountPercent?: number;
  @IsOptional() @IsIn(['HARD', 'ADVISORY']) sectionCapacityMode?: string;
  @IsOptional() @IsIn(['DIRECT', 'PIPELINE']) admissionsMode?: string;
  @IsOptional() @IsBoolean() promotionRequiresFeeClearance?: boolean;
  @IsOptional() @IsBoolean() payrollDeductsAbsence?: boolean;
  @IsOptional() @IsInt() @Min(0) smsOverdraftSegments?: number;

  @IsOptional() @ValidateNested() @Type(() => StaffLeaveQuotasDto)
  staffLeaveQuotas?: StaffLeaveQuotasDto;

  @IsOptional() @ValidateNested() @Type(() => StaffAttendanceSettingsDto)
  staffAttendance?: StaffAttendanceSettingsDto;

  @IsOptional() @ValidateNested() @Type(() => FeeSubmissionSettingsDto)
  feeSubmission?: FeeSubmissionSettingsDto;
}
