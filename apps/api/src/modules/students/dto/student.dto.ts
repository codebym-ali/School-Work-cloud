import { Type } from 'class-transformer';
import {
  IsBoolean,
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
import { Gender, GuardianRelation } from '@prisma/client';
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
}

export class CreateStudentDto {
  @IsString() @MinLength(1) @MaxLength(120)
  fullName!: string;

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

  /** Only honoured when the school is in MANUAL GR mode. */
  @IsOptional() @IsString() @MaxLength(40)
  grNumber?: string;

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

  @IsOptional() @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';
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
