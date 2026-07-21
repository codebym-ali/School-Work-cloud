import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Roles } from '@common';
import { RecruitmentService } from './recruitment.service';
import { CreateVacancyDto, ListVacancyQuery } from './dto/hr.dto';

/**
 * Recruitment — vacancies (HR module). OWNER_ADMIN posts/closes for any campus; CAMPUS_ADMIN
 * is scoped to their own campus by the service (§22.8). Reads are campus-scoped too.
 */
@Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'HR_MANAGER')
@Controller('vacancies')
export class VacanciesController {
  constructor(private readonly recruitment: RecruitmentService) {}

  @Post()
  create(@Body() dto: CreateVacancyDto) {
    return this.recruitment.create(dto);
  }

  @Get()
  list(@Query() q: ListVacancyQuery) {
    return this.recruitment.list(q);
  }

  @Post(':id/close')
  close(@Param('id') id: string) {
    return this.recruitment.close(id);
  }
}
