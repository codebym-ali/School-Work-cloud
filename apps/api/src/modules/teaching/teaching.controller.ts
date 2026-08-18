import { Controller, Get, Param } from '@nestjs/common';
import { Roles } from '@common';
import { TeachingService } from './teaching.service';

/**
 * Teacher self-service — "my classes" + section rosters (§9/§11). TEACHER-only; the caller's
 * assigned sections are resolved from their own StaffProfile, and roster access is gated to
 * sections they actually hold an assignment for (ownership enforced in the service, §22.8).
 */
@Roles('TEACHER')
@Controller('teaching')
export class TeachingController {
  constructor(private readonly teaching: TeachingService) {}

  @Get('my-classes')
  myClasses() {
    return this.teaching.myClasses();
  }

  @Get('sections/:sectionId/roster')
  roster(@Param('sectionId') sectionId: string) {
    return this.teaching.roster(sectionId);
  }
}
