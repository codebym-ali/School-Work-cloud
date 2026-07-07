import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ExamType } from '@prisma/client';

// ── Grade scales ─────────────────────────────────────────────────────────────
export class GradeBandDto {
  @IsString() @MinLength(1) @MaxLength(8)
  label!: string;

  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100)
  minPercent!: number;

  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100)
  maxPercent!: number;

  @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(10)
  gradePoint!: number;
}

export class SetGradeScaleDto {
  @IsUUID() academicYearId!: string;

  @IsArray() @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => GradeBandDto)
  bands!: GradeBandDto[];
}

// ── Terms ────────────────────────────────────────────────────────────────────
export class CreateTermDto {
  @IsUUID() academicYearId!: string;
  @IsString() @MinLength(1) @MaxLength(40) name!: string;
  @IsDateString() startDate!: string;
  @IsDateString() endDate!: string;
}

// ── Exam definitions ─────────────────────────────────────────────────────────
export class CreateExamDto {
  @IsUUID() termId!: string;
  @IsUUID() classId!: string;
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsEnum(ExamType) examType!: ExamType;

  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100)
  weightagePercent!: number;

  @IsDateString() examDate!: string;
}

// ── Marks entry ──────────────────────────────────────────────────────────────
export class MarkRowDto {
  @IsUUID() enrollmentId!: string;
  @IsUUID() subjectId!: string;

  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0)
  totalMarks!: number;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0)
  marksObtained?: number;

  @IsOptional() @IsBoolean()
  isAbsent?: boolean;
}

export class BulkMarksDto {
  @IsArray() @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MarkRowDto)
  records!: MarkRowDto[];
}
