import { Controller, Get, Query } from '@nestjs/common';
import { IsDateString, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { KeysetQuery, Roles } from '@common';
import { AuditQueryService, DashboardService } from './insights.service';

@Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  get() {
    return this.dashboard.get();
  }
}

/**
 * Filters for the activity log. Cursor-paged (`KeysetQuery`) rather than page-numbered: the table only
 * grows, and page numbers shift under a reader every time something new is recorded.
 */
class AuditQueryDto extends KeysetQuery {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsString() @MaxLength(60) action?: string;
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsString() @MaxLength(60) entityType?: string;
  @IsOptional() @IsUUID() entityId?: string;
}

@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Get()
  list(@Query() q: AuditQueryDto) {
    return this.audit.list(q);
  }
}
