import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
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
}

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post('certificates')
  issue(@Body() dto: IssueCertDto) {
    return this.documents.issueCertificate(dto);
  }

  @Get()
  list(@Query('studentId') studentId: string) {
    return this.documents.listForStudent(studentId);
  }

  @Get(':id/url')
  url(@Param('id', ParseUUIDPipe) id: string) {
    return this.documents.getUrl(id);
  }
}

@Controller('students')
export class WithdrawalController {
  constructor(private readonly documents: DocumentsService) {}

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post(':id/withdraw')
  withdraw(@Param('id', ParseUUIDPipe) id: string, @Body() dto: WithdrawDto) {
    return this.documents.withdraw(id, dto);
  }
}
