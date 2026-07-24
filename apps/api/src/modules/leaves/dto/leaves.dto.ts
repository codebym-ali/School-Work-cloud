import { IsDateString, IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { LeaveStatus, StaffLeaveType } from '@prisma/client';
import { PaginationQuery } from '@common';

export class CreateStudentLeaveDto {
  @IsUUID()
  studentId!: string;

  @IsDateString()
  fromDate!: string;

  @IsDateString()
  toDate!: string;

  @IsString() @MinLength(1) @MaxLength(500)
  reason!: string;
}

export class CreateStaffLeaveDto {
  /** Whose leave this is. Omitted by staff/teachers (resolved to their own profile);
   *  an admin filing on someone's behalf supplies it explicitly. */
  @IsOptional() @IsUUID()
  staffId?: string;

  @IsEnum(StaffLeaveType)
  leaveType!: StaffLeaveType;

  @IsDateString()
  fromDate!: string;

  @IsDateString()
  toDate!: string;

  @IsString() @MinLength(1) @MaxLength(500)
  reason!: string;
}

export class RejectLeaveDto {
  @IsString() @MinLength(1) @MaxLength(500)
  reason!: string;
}

export class LeaveListQuery extends PaginationQuery {
  @IsOptional() @IsEnum(LeaveStatus)
  status?: LeaveStatus;

  @IsOptional() @IsUUID()
  studentId?: string;

  @IsOptional() @IsUUID()
  staffId?: string;
}
