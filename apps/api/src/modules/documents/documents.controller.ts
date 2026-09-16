import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { IsBoolean, IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Roles } from '@common';
import { DocumentsService } from './documents.service';

class IssueCertDto {
  @IsUUID() studentId!: string;
  @IsIn(['LEAVING_CERT', 'CHARACTER_CERT', 'FEE_CLEARANCE'])
  type!: 'LEAVING_CERT' | 'CHARACTER_CERT' | 'FEE_CLEARANCE';
  @IsOptional() @IsBoolean() overrideFeeClearance?: boolean;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

class WithdrawDto {
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
  @IsOptional() @IsBoolean() overrideFeeClearance?: boolean;
  /**
   * The day the student left, as the office records it (YYYY-MM-DD). Omitted means today. Like the
   * admission date, it is an office fact rather than a timestamp: a family often gives notice and the
   * paperwork is done days later. It decides which already-raised invoices are for months after leaving.
   */
  @IsOptional() @IsDateString() leavingDate?: string;
}

class DocumentListQuery {
  @IsUUID() studentId!: string;
}

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post('certificates')
  issue(@Body() dto: IssueCertDto) {
    return this.documents.issueCertificate(dto);
  }

  /**
   * ⚠️ Until 2026-09-16 both read routes had NO `@Roles` and the service performed no ownership check,
   * although `getUrl` was documented "after an ownership check" — any signed-in user in the school could
   * list a student's issued documents and mint a download link to any of them. Restricted to the roles
   * that issue documents, and campus-scoped in the service.
   */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Get()
  list(@Query() q: DocumentListQuery) {
    return this.documents.listForStudent(q.studentId);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Get(':id/url')
  url(@Param('id') id: string) {
    return this.documents.getUrl(id);
  }
}

@Controller('students')
export class WithdrawalController {
  constructor(private readonly documents: DocumentsService) {}

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post(':id/withdraw')
  withdraw(@Param('id') id: string, @Body() dto: WithdrawDto) {
    return this.documents.withdraw(id, dto);
  }
}
