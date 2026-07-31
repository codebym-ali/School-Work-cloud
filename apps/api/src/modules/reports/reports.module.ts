import { Module } from '@nestjs/common';
import { PerformanceController } from './performance.controller';
import { PerformanceService } from './performance.service';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { AuditQueryService, DashboardService } from './insights.service';
import { AuditController, DashboardController } from './insights.controller';

/** Reports, dashboard & audit browser (blueprint §28, §24). */
@Module({
  controllers: [PerformanceController, ReportsController, DashboardController, AuditController],
  providers: [PerformanceService, ReportsService, DashboardService, AuditQueryService],
  exports: [ReportsService],
})
export class ReportsModule {}
