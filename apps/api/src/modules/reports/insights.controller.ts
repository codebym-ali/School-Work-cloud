import { Controller, Get, Query } from '@nestjs/common';
import { IsDateString, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { KeysetQuery, Roles } from '@common';
import { AuditQueryService, DashboardService } from './insights.service';

class DashboardQueryDto {
  @IsOptional() @IsUUID() campusId?: string;
}

@Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  // The owner may narrow the whole dashboard to one campus (the campus "lens"); a campus-bound
  // user is forced to their own campus server-side, so their client value is ignored.
  @Get()
  get(@Query() q: DashboardQueryDto) {
    return this.dashboard.get(q.campusId);
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
