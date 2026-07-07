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

export class CreateStaffDto {
  @IsEmail() email!: string;

  @IsEnum(StaffType) staffType!: StaffType;

  @IsString() @MinLength(1) @MaxLength(40) employeeCode!: string;
  @IsString() @MinLength(1) @MaxLength(80) designation!: string;
  @IsDateString() joinedAt!: string;

  @IsOptional() @IsUUID() campusId?: string;

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

export class MarkPaidDto {
  @IsEnum({ CASH: 'CASH', BANK_TRANSFER: 'BANK_TRANSFER', CHEQUE: 'CHEQUE' })
  method!: 'CASH' | 'BANK_TRANSFER' | 'CHEQUE';

  @IsOptional() @IsString() @MaxLength(120)
  reference?: string;
}
