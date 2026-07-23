import { Controller, Get, Param } from '@nestjs/common';
import { Roles } from '@common';
import { ParentPortalService } from './parent-portal.service';

/**
 * Parent self-service portal (§28). PARENT-only; every route is read-only and guardian-scoped
 * in the service — a `studentId` that isn't one of the caller's children is 403'd (§22.8).
 */
@Roles('PARENT')
@Controller('parent')
export class ParentPortalController {
  constructor(private readonly portal: ParentPortalService) {}

  @Get('children')
  children() {
    return this.portal.children();
  }

  @Get('children/:studentId/overview')
  overview(@Param('studentId') studentId: string) {
    return this.portal.overview(studentId);
  }

  @Get('children/:studentId/attendance')
  attendance(@Param('studentId') studentId: string) {
    return this.portal.attendance(studentId);
  }

  @Get('children/:studentId/results')
  results(@Param('studentId') studentId: string) {
    return this.portal.results(studentId);
  }

  @Get('children/:studentId/fees')
  fees(@Param('studentId') studentId: string) {
    return this.portal.fees(studentId);
  }
}
