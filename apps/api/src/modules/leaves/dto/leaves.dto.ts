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

export class LeaveBalanceQuery {
  /** Admins may ask about anyone; staff and teachers are forced to their own profile. */
  @IsOptional() @IsUUID()
  staffId?: string;

  /**
   * Optional "what would this cost me?" — supply all three and the response carries a `proposed`
   * block priced by the same function that stamps the real thing at create and approve.
   *
   * The alternative was reimplementing the school's calendar in the browser to count working
   * days. That is the drift this codebase has been bitten by before (three copies of the
   * attendance percentage gave three different answers), and here the two copies would disagree
   * about somebody's salary.
   */
  @IsOptional() @IsDateString()
  fromDate?: string;

  @IsOptional() @IsDateString()
  toDate?: string;

  @IsOptional() @IsEnum(StaffLeaveType)
  leaveType?: StaffLeaveType;
}

export class LeaveListQuery extends PaginationQuery {
  @IsOptional() @IsEnum(LeaveStatus)
  status?: LeaveStatus;

  @IsOptional() @IsUUID()
  studentId?: string;

  @IsOptional() @IsUUID()
  staffId?: string;

  /** Campus lens; forced to the caller's own campus when they are campus-bound. */
  @IsOptional() @IsUUID()
  campusId?: string;
}
