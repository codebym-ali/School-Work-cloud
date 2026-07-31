import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '@common';
import { ClassTestsService } from './class-tests.service';
import {
  CreateClassTestDto,
  ListClassTestQuery,
  SetClassTestScoresDto,
  UpdateClassTestDto,
} from './dto/class-test.dto';

/**
 * Class tests (§11 extension). Teacher-owned formative assessment.
 *
 * Ownership — that the teacher actually teaches this (section, subject) — is enforced INSIDE the
 * service (§22.8): guards run before the `withTenant` tx, so they cannot read the assignment
 * rows the check needs. Admins may view and step in; a principal reviewing how often a teacher
 * assesses is legitimate oversight.
 */
@Roles('TEACHER', 'CAMPUS_ADMIN', 'OWNER_ADMIN')
@Controller('class-tests')
export class ClassTestsController {
  constructor(private readonly tests: ClassTestsService) {}

  @Post()
  create(@Body() dto: CreateClassTestDto) {
    return this.tests.create(dto);
  }

  @Get()
  list(@Query() q: ListClassTestQuery) {
    return this.tests.list(q);
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.tests.getOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateClassTestDto) {
    return this.tests.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.tests.remove(id);
  }

  /** Enter or correct marks — partial-failure, so one bad row never rejects a whole register. */
  @Post(':id/scores')
  setScores(@Param('id') id: string, @Body() dto: SetClassTestScoresDto) {
    return this.tests.setScores(id, dto);
  }
}
