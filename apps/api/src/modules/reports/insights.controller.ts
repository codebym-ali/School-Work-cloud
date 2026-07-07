import { Controller, Get, Query } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { PaginationQuery, Roles } from '@common';
import { AuditQueryService, DashboardService } from './insights.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  get() {
    return this.dashboard.get();
  }
}

class AuditQueryDto extends PaginationQuery {
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @IsString() action?: string;
  @IsOptional() @IsString() userId?: string;
  @IsOptional() @IsString() entityType?: string;
  @IsOptional() @IsString() entityId?: string;
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
