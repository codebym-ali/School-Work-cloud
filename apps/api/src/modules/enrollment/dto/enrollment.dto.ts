import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { EnrollmentStatus } from '@prisma/client';
import { PaginationQuery } from '@common';

export class EnrollmentListQuery extends PaginationQuery {
  @IsOptional() @IsUUID()
  academicYearId?: string;

  @IsOptional() @IsUUID()
  sectionId?: string;

  @IsOptional() @IsUUID()
  studentId?: string;

  @IsOptional() @IsEnum(EnrollmentStatus)
  status?: EnrollmentStatus;
}

export class TransferDto {
  @IsUUID()
  studentId!: string;

  @IsUUID()
  toSectionId!: string;
}
