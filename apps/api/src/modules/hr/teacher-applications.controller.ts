import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '@common';
import { TeacherApplicationsService } from './teacher-applications.service';
import {
  CreateTeacherApplicationDto,
  HireApplicantDto,
  ListTeacherApplicationQuery,
  UpdateApplicationStatusDto,
} from './dto/teacher-application.dto';

/**
 * Teacher applications — the dedicated Add-Teacher form (HR module). OWNER_ADMIN / CAMPUS_ADMIN
 * (and HR_MANAGER) manage them; campus scoping is enforced in the service (§22.8).
 */
@Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'HR_MANAGER')
@Controller('teacher-applications')
export class TeacherApplicationsController {
  constructor(private readonly applications: TeacherApplicationsService) {}

  @Post()
  create(@Body() dto: CreateTeacherApplicationDto) {
    return this.applications.create(dto);
  }

  @Get()
  list(@Query() q: ListTeacherApplicationQuery) {
    return this.applications.list(q);
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.applications.getOne(id);
  }

  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateApplicationStatusDto) {
    return this.applications.updateStatus(id, dto);
  }

  @Post(':id/hire')
  hire(@Param('id') id: string, @Body() dto: HireApplicantDto) {
    return this.applications.hire(id, dto);
  }
}
