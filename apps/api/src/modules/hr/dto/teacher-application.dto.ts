import {
  IsArray, IsDateString, IsEmail, IsEnum, IsIn, IsNumber, IsObject, IsOptional,
  IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { EmploymentType, StaffType, TeacherApplicationStatus } from '@prisma/client';

/** One prior job (repeats in the Experience section). */
export class ExperienceEntryDto {
  @IsString() @MinLength(1) @MaxLength(160) schoolName!: string;
  @IsOptional() @IsString() @MaxLength(120) position?: string;
  @IsOptional() @IsString() @MaxLength(200) subjectsTaught?: string;
  @IsOptional() @IsString() @MaxLength(120) gradesTaught?: string;
  @IsOptional() @IsString() @MaxLength(60) duration?: string;
  @IsOptional() @IsString() @MaxLength(300) reasonForLeaving?: string;
}

/** The full form beyond the queryable columns: personal, contact, education, experience, skills. */
export class TeacherApplicationDetailsDto {
  // Personal
  @IsString() @MinLength(1) @MaxLength(120) fatherName!: string;
  @IsDateString() dateOfBirth!: string;
  @IsIn(['MALE', 'FEMALE', 'OTHER']) gender!: string;
  @IsString() @MinLength(5) @MaxLength(20) cnic!: string;
  @IsOptional() @IsString() @MaxLength(20) maritalStatus?: string;
  @IsOptional() @IsString() @MaxLength(60) nationality?: string;
  @IsOptional() @IsString() @MaxLength(500) photoUrl?: string;

  // Contact
  @IsOptional() @IsString() @MaxLength(20) whatsapp?: string;
  @IsString() @MinLength(1) @MaxLength(240) currentAddress!: string;
  @IsOptional() @IsString() @MaxLength(240) permanentAddress?: string;
  @IsString() @MinLength(1) @MaxLength(80) city!: string;
  @IsOptional() @IsString() @MaxLength(80) province?: string;
  @IsOptional() @IsString() @MaxLength(20) postalCode?: string;

  // Position extras
  @IsOptional() @IsString() @MaxLength(240) preferredSubjects?: string;
  @IsOptional() @IsString() @MaxLength(120) gradeLevels?: string;

  // Education
  @IsString() @MinLength(1) @MaxLength(120) highestQualification!: string;
  @IsOptional() @IsString() @MaxLength(160) degreeTitle?: string;
  @IsOptional() @IsString() @MaxLength(120) majorSubject?: string;
  @IsOptional() @IsString() @MaxLength(160) university?: string;
  @IsOptional() @IsNumber() @Min(1950) @Max(2100) passingYear?: number;
  @IsOptional() @IsString() @MaxLength(40) cgpa?: string;

  // Experience
  @IsOptional() @IsString() @MaxLength(40) totalExperience?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ExperienceEntryDto)
  experiences?: ExperienceEntryDto[];

  // Skills
  @IsOptional() @IsString() @MaxLength(200) languages?: string;
  @IsOptional() @IsString() @MaxLength(200) computerSkills?: string;
  @IsOptional() @IsString() @MaxLength(200) lmsExperience?: string;
  @IsOptional() @IsString() @MaxLength(200) msOfficeSkills?: string;
  @IsOptional() @IsString() @MaxLength(300) classroomManagement?: string;
}

export class CreateTeacherApplicationDto {
  @IsUUID() campusId!: string;
  @IsString() @MinLength(2) @MaxLength(120) fullName!: string;
  @IsEmail() email!: string;
  @IsString() @MinLength(7) @MaxLength(20) mobile!: string;
  @IsString() @MinLength(2) @MaxLength(120) positionAppliedFor!: string;
  @IsString() @MinLength(2) @MaxLength(80) department!: string;
  @IsEnum(EmploymentType) employmentType!: EmploymentType;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) expectedSalary?: number;
  @IsOptional() @IsDateString() availableJoiningDate?: string;

  @IsObject() @ValidateNested() @Type(() => TeacherApplicationDetailsDto)
  details!: TeacherApplicationDetailsDto;
}

export class ListTeacherApplicationQuery {
  @IsOptional() @IsUUID() campusId?: string;
  @IsOptional() @IsEnum(TeacherApplicationStatus) status?: TeacherApplicationStatus;
  @IsOptional() @IsString() @MaxLength(120) search?: string;
}

/**
 * Advance an application in the hiring pipeline. Only SHORTLISTED and REJECTED are
 * reachable here; HIRED is set exclusively by the /hire endpoint (which also creates the
 * staff account), so a HIRED application always has a real login behind it.
 */
export class UpdateApplicationStatusDto {
  @IsIn(['SHORTLISTED', 'REJECTED'])
  status!: 'SHORTLISTED' | 'REJECTED';

  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

/**
 * Hire an applicant: creates the staff User (INVITED) + StaffProfile from the application
 * and marks it HIRED, atomically (one request tx). Campus comes from the application.
 */
export class HireApplicantDto {
  @IsString() @MinLength(1) @MaxLength(40) employeeCode!: string;

  /** Defaults to the application's positionAppliedFor when omitted. */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) designation?: string;

  /** Defaults to today when omitted. */
  @IsOptional() @IsDateString() joinedAt?: string;

  /** Defaults to TEACHER. */
  @IsOptional() @IsEnum(StaffType) staffType?: StaffType;
}
