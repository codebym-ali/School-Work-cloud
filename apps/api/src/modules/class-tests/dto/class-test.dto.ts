import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CreateClassTestDto {
  @IsUUID() sectionId!: string;
  @IsUUID() subjectId!: string;

  @IsString() @MinLength(1) @MaxLength(80) name!: string;

  /** What the test is out of. Tests differ (10, 50), so rollups normalise to a percentage. */
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) totalMarks!: number;

  @IsDateString() testDate!: string;
}

export class UpdateClassTestDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) totalMarks?: number;
  @IsOptional() @IsDateString() testDate?: string;
}

export class ClassTestScoreRowDto {
  @IsUUID() enrollmentId!: string;

  /** Omitted when absent. Absences are excluded from averages, never scored 0. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) marksObtained?: number;

  @IsOptional() @IsBoolean() isAbsent?: boolean;
}

export class SetClassTestScoresDto {
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true })
  @Type(() => ClassTestScoreRowDto)
  rows!: ClassTestScoreRowDto[];
}

export class ListClassTestQuery {
  @IsOptional() @IsUUID() sectionId?: string;
  @IsOptional() @IsUUID() subjectId?: string;
}
