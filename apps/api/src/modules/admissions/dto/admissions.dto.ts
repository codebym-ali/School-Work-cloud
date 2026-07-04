import { Type } from 'class-transformer';
import {
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
import { Gender, InquiryStatus } from '@prisma/client';
import { PaginationQuery } from '@common';
import { GuardianResolutionDto } from '../../students/dto/student.dto';

export class CreateInquiryDto {
  @IsUUID()
  campusId!: string;

  @IsString() @MinLength(1) @MaxLength(120)
  guardianName!: string;

  @IsString()
  guardianPhone!: string;

  @IsString() @MinLength(1) @MaxLength(120)
  studentName!: string;

  @IsUUID()
  desiredClassId!: string;
}

export class InquiryListQuery extends PaginationQuery {
  @IsOptional() @IsUUID()
  campusId?: string;

  @IsOptional() @IsEnum(InquiryStatus)
  status?: InquiryStatus;
}

export class ScheduleEntryTestDto {
  @IsDateString()
  scheduledAt!: string;
}

export class RecordEntryTestDto {
  @IsBoolean()
  passed!: boolean;

  @IsOptional() @IsNumber() @Min(0) @Max(1000)
  score?: number;

  @IsOptional() @IsString() @MaxLength(500)
  remarks?: string;
}

export class ReasonDto {
  @IsString() @MinLength(1) @MaxLength(500)
  reason!: string;
}

export class AdmitDto {
  @IsUUID()
  inquiryId!: string;

  /** Defaults to the inquiry's studentName when omitted. */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  fullName?: string;

  @IsEnum(Gender)
  gender!: Gender;

  @IsDateString()
  dateOfBirth!: string;

  @IsUUID()
  classId!: string;

  @IsUUID()
  sectionId!: string;

  @ValidateNested()
  @Type(() => GuardianResolutionDto)
  guardian!: GuardianResolutionDto;

  @IsOptional() @IsString() @MaxLength(40)
  grNumber?: string;
}
