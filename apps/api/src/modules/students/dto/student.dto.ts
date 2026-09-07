import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsBooleanString,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Gender, GuardianRelation, StudentStatus } from '@prisma/client';
import { PaginationQuery } from '@common';

/**
 * Guardian resolution (blueprint §8): the client makes an EXPLICIT choice —
 * LINK an existing parent (by id, found via phone match) or CREATE a new one.
 * The server never silently auto-merges.
 */
export class GuardianResolutionDto {
  @IsIn(['LINK', 'CREATE'])
  mode!: 'LINK' | 'CREATE';

  @ValidateIf((o: GuardianResolutionDto) => o.mode === 'LINK')
  @IsUUID()
  parentId?: string;

  @ValidateIf((o: GuardianResolutionDto) => o.mode === 'CREATE')
  @IsString() @MinLength(1) @MaxLength(120)
  fullName?: string;

  @ValidateIf((o: GuardianResolutionDto) => o.mode === 'CREATE')
  @IsString()
  phone?: string;

  // A guardian always has a relation to the student, whether linked or created.
  @IsEnum(GuardianRelation)
  relation!: GuardianRelation;

  @IsOptional() @IsString() @MaxLength(20)
  cnic?: string;

  @IsOptional() @IsEmail()
  email?: string;

  /** Asked for on every Pakistani admission form and printed on board forms. Only meaningful on
   *  CREATE — linking an existing parent must not silently rewrite their record from a new form. */
  @IsOptional() @IsString() @MaxLength(120)
  occupation?: string;
}

export class CreateStudentDto {
  @IsString() @MinLength(1) @MaxLength(120)
  fullName!: string;

  @IsEnum(Gender)
  gender!: Gender;

  @IsDateString()
  dateOfBirth!: string;

  /** Chosen on the admission form; the class must belong to this campus. */
  @IsUUID()
  campusId!: string;

  @IsUUID()
  classId!: string;

  @IsUUID()
  sectionId!: string;

  /**
   * OPTIONAL (§8): a walk-in can be seated now and the guardian recorded later, which is how
   * a front desk actually works. Omitting it is a real cost, not a free choice — the student
   * gets NO absence / fee-receipt / result SMS, because every dispatch resolves the primary
   * guardian and returns quietly when there isn't one. `Student.hasGuardian` surfaces the gap
   * so it can be chased; `POST /students/:id/guardians` closes it.
   *
   * Still fully validated WHEN SUPPLIED — a half-filled guardian is rejected, not silently
   * dropped, so "no guardian" is always a deliberate choice rather than a typo.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => GuardianResolutionDto)
  guardian?: GuardianResolutionDto;

  /**
   * **Father, Mother, and anyone else** — the normal case, not an edge case (Tier 1).
   *
   * ⚠️ `guardian` above stays for the callers that genuinely have one: CSV import and the pipeline
   * admit. When both are sent this wins. The FIRST entry becomes the primary guardian — the one every
   * SMS dispatch and fee receipt resolves — so the form must send the fee-paying parent first.
   *
   * Capped at four: a child with five custodial adults is a data-entry error, and an uncapped array
   * on an unauthenticated-shaped payload is a cheap way to make the server do unbounded work.
   */
  @IsOptional()
  @IsArray() @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => GuardianResolutionDto)
  guardians?: GuardianResolutionDto[];

  /** Religion — free text, not an enum: a school may need a spelling its board uses (Tier 1). */
  @IsOptional() @IsString() @MaxLength(40)
  religion?: string;

  @IsOptional() @IsString() @MaxLength(240)
  addressLine?: string;

  @IsOptional() @IsString() @MaxLength(80)
  city?: string;

  /** ⚠️ The person to ring when a child is hurt — NOT the fee-paying guardian, and often not a
   *  parent at all, which is why it is three plain fields rather than another guardian. */
  @IsOptional() @IsString() @MaxLength(120)
  emergencyName?: string;

  @IsOptional() @IsString() @MaxLength(20)
  emergencyPhone?: string;

  @IsOptional() @IsString() @MaxLength(40)
  emergencyRelation?: string;

  /** Student CNIC / B-Form (digits, dashes allowed). When present, the portal login is
   *  provisioned and this is the second factor for the CNIC + registration-no sign-in. */
  @IsOptional() @IsString() @Matches(/^\d{5}-?\d{7}-?\d$/, { message: 'CNIC/B-Form must be 13 digits' })
  cnic?: string;

  /** Proceed despite an age-eligibility mismatch (soft-warn block, §8) — recorded in the audit. */
  @IsOptional() @IsBoolean()
  ageOverride?: boolean;

  /** Only honoured when the school is in MANUAL GR mode. */
  @IsOptional() @IsString() @MaxLength(40)
  grNumber?: string;

  /**
   * The office-set **joining date** (Admission Form Field Gaps, Tier 1). Optional; defaults to today.
   *
   * ⚠️ **Not the row's `createdAt`.** A back-dated admission is routine — the child started on the
   * 1st and the office keyed it in on the 5th — and the difference is money: the enrolment's
   * `startedAt` is what fee proration and seniority read. Deriving it from a timestamp silently
   * bills from the wrong day, and nothing downstream can tell it was wrong.
   *
   * Stored as `StudentEnrollment.startedAt`, which already existed and was simply never settable —
   * so this adds no column and no second source of truth for "when did they join".
   */
  @IsOptional() @IsDateString()
  admissionDate?: string;

  /** Manual roll number — optional; unique within the section for the academic year. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000)
  rollNumber?: number;
}

export class ImportStudentsDto {
  /** Raw CSV text. Required columns: fullName,gender,dateOfBirth,className,sectionName,
   *  guardianName,guardianPhone,relation. Optional: campusName,guardianCnic,guardianEmail,grNumber. */
  @IsString() @MinLength(1) @MaxLength(1_000_000)
  csv!: string;

  /** Validate only — report row errors without importing anything. */
  @IsOptional() @IsBoolean()
  dryRun?: boolean;
}

export class ConfirmOtpDto {
  @IsString() @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;
}

export class UpdateStudentDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  fullName?: string;

  @IsOptional() @IsEnum(Gender)
  gender?: Gender;

  @IsOptional() @IsDateString()
  dateOfBirth?: string;

  /**
   * The admission-record fields, editable after the fact — this is the other half of "admit fast,
   * then complete the record". A walk-in seated in a minute has none of these, and the office must
   * be able to fill them in without re-admitting the child.
   */
  @IsOptional() @IsString() @MaxLength(40)
  religion?: string;

  @IsOptional() @IsString() @MaxLength(240)
  addressLine?: string;

  @IsOptional() @IsString() @MaxLength(80)
  city?: string;

  @IsOptional() @IsString() @MaxLength(120)
  emergencyName?: string;

  @IsOptional() @IsString() @MaxLength(20)
  emergencyPhone?: string;

  @IsOptional() @IsString() @MaxLength(40)
  emergencyRelation?: string;
}

/** Status changes are events, not profile edits — hence a dedicated DTO carrying a
 *  mandatory reason (it lands in the audit log) rather than a field on UpdateStudentDto. */
export class ChangeStudentStatusDto {
  @IsEnum(StudentStatus)
  status!: StudentStatus;

  @IsString() @MinLength(3) @MaxLength(500)
  reason!: string;

  @IsOptional() @IsDateString()
  effectiveFrom?: string;

  /** Required for SUSPENDED — the date the suspension lifts. */
  @ValidateIf((o: ChangeStudentStatusDto) => o.status === StudentStatus.SUSPENDED)
  @IsDateString()
  endsOn?: string;
}

/** Record or replace a student's CNIC/B-Form after admission (§8/§28). */
export class SetStudentCnicDto {
  @IsString() @Matches(/^\d{5}-?\d{7}-?\d$/, { message: 'CNIC/B-Form must be 13 digits' })
  cnic!: string;
}

export class StudentSearchQuery extends PaginationQuery {
  /** name (trigram), exact GR, or guardian phone. */
  @IsOptional() @IsString()
  search?: string;

  @IsOptional() @IsUUID()
  campusId?: string;

  @IsOptional() @IsUUID()
  classId?: string;

  @IsOptional() @IsUUID()
  sectionId?: string;

  /** 'INACTIVE' is kept for existing callers: it means "anything but ACTIVE". */
  @IsOptional() @IsIn([...Object.values(StudentStatus), 'INACTIVE'])
  status?: StudentStatus | 'INACTIVE';

  /**
   * Only students with NO guardian on record. This is the chase list: admitting without a
   * guardian is allowed, but those students receive no SMS of any kind, so the gap has to be
   * findable rather than silently permanent.
   */
  @IsOptional() @IsBooleanString()
  missingGuardian?: string;
}

export class AddGuardianDto extends GuardianResolutionDto {
  @IsOptional()
  isPrimary?: boolean;
}

export class UpdateGuardianDto {
  @IsOptional() @IsEnum(GuardianRelation)
  relation?: GuardianRelation;

  @IsOptional()
  isPrimary?: boolean;
}
