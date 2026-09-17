import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Role, StaffType } from '@prisma/client';
import { Type } from 'class-transformer';

export class CreateStaffDto {
  @IsEmail() email!: string;

  @IsEnum(StaffType) staffType!: StaffType;

  @IsString() @MinLength(1) @MaxLength(40) employeeCode!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) fullName?: string;
  @IsString() @MinLength(1) @MaxLength(80) designation!: string;
  @IsDateString() joinedAt!: string;

  @IsOptional() @IsUUID() campusId?: string;

  /** Set a password here and the account is usable immediately (ACTIVE) instead of sitting
   *  INVITED with no way in — the school hands the teacher these credentials on the spot. */
  @IsOptional() @IsString() @MinLength(10) @MaxLength(200)
  password?: string;

  /** Roles to grant the created User (e.g. [TEACHER]); must align with staffType. */
  @IsOptional() @IsEnum(Role, { each: true })
  roles?: Role[];
}

export class CreateSalaryStructureDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) basic!: number;

  @IsOptional() @IsObject() allowances?: Record<string, number>;
  @IsOptional() @IsObject() deductionsFixed?: Record<string, number>;

  @IsDateString() effectiveFrom!: string;
}

export class CreateTeacherAssignmentDto {
  @IsUUID() staffId!: string;
  @IsUUID() academicYearId!: string;
  @IsUUID() sectionId!: string;

  @IsOptional() @IsUUID()
  subjectId?: string; // null ⇒ homeroom/class-teacher
}

export class RunPayrollDto {
  @IsUUID() campusId!: string;
  @IsInt() @Min(1) @Max(12) month!: number;
  @IsInt() @Min(2000) @Max(3000) year!: number;
}

export class PayrollRunListQuery {
  @IsOptional() @IsUUID() campusId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(2000) @Max(3000) year?: number;
}

export class MarkPaidDto {
  @IsEnum({ CASH: 'CASH', BANK_TRANSFER: 'BANK_TRANSFER', CHEQUE: 'CHEQUE' })
  method!: 'CASH' | 'BANK_TRANSFER' | 'CHEQUE';

  @IsOptional() @IsString() @MaxLength(120)
  reference?: string;
}

// Vacancy DTOs removed with the vacancy board (2026-07-30) — see HrModule.
