import { Controller, Get } from '@nestjs/common';
import { Roles } from '@common';
import { StudentPortalService } from './student-portal.service';

/**
 * Student self-service portal (§28). STUDENT-only; every route is read-only and resolves
 * the caller's own Student record in the service (SelfGuard, §22.8) — no id is accepted
 * from the client, so cross-student access is structurally impossible.
 */
@Roles('STUDENT')
@Controller('portal')
export class StudentPortalController {
  constructor(private readonly portal: StudentPortalService) {}

  @Get('overview')
  overview() {
    return this.portal.overview();
  }

  @Get('attendance')
  attendance() {
    return this.portal.attendance();
  }

  @Get('results')
  results() {
    return this.portal.results();
  }

  @Get('fees')
  fees() {
    return this.portal.fees();
  }
}
