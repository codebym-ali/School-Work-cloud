import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
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
}

export class UpdateSectionDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(40) name?: string;
  @IsOptional() @IsInt() @Min(1) @Max(200) capacity?: number;
}

export class UpdateSubjectDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
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
