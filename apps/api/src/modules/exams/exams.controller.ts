import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { Roles } from '@common';
import { ExamSetupService } from './exam-setup.service';
import { ExamsService } from './exams.service';
import { ReportCardsService } from './report-cards.service';
import { BulkMarksDto, CreateExamDto, CreateTermDto, SetGradeScaleDto } from './dto/exams.dto';

@Controller('grade-scales')
export class GradeScalesController {
  constructor(private readonly setup: ExamSetupService) {}
  @Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN') @Put() set(@Body() dto: SetGradeScaleDto) { return this.setup.setGradeScale(dto); }
  @Get() get(@Query('academicYearId') yearId: string) { return this.setup.getGradeScale(yearId); }
}

@Controller('terms')
export class TermsController {
  constructor(
    private readonly setup: ExamSetupService,
    private readonly reportCards: ReportCardsService,
  ) {}

  @Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN') @Post() create(@Body() dto: CreateTermDto) { return this.setup.createTerm(dto); }
  @Get() list(@Query('academicYearId') yearId?: string) { return this.setup.listTerms(yearId); }

  // Remove a term created by mistake. Blocked (409) once exams/report cards reference it.
  @Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN') @Delete(':id') remove(@Param('id') id: string) { return this.setup.deleteTerm(id); }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post(':id/report-cards/generate')
  generate(@Param('id') id: string) { return this.reportCards.generate(id); }

  @Get(':id/report-cards')
  termReportCards(@Param('id') id: string) { return this.reportCards.listByTerm(id); }
}

@Controller('exams')
export class ExamsController {
  constructor(private readonly exams: ExamsService) {}

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN') @Post() create(@Body() dto: CreateExamDto) { return this.exams.createExam(dto); }
  @Get() list(@Query('classId') classId?: string, @Query('termId') termId?: string) { return this.exams.listExams(classId, termId); }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post(':id/open-marks-entry')
  open(@Param('id') id: string) { return this.exams.openMarksEntry(id); }

  @Roles('TEACHER', 'CAMPUS_ADMIN', 'OWNER_ADMIN')
  @Post(':id/results/bulk')
  @HttpCode(HttpStatus.OK)
  enterMarks(@Param('id') id: string, @Body() dto: BulkMarksDto) { return this.exams.enterMarks(id, dto); }

  @Get(':id/results')
  results(@Param('id') id: string) { return this.exams.getResults(id); }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post(':id/publish')
  publish(@Param('id') id: string) { return this.exams.publish(id); }
}

@Controller('students')
export class StudentReportCardsController {
  constructor(private readonly reportCards: ReportCardsService) {}
  @Get(':id/report-cards')
  byStudent(@Param('id') id: string) { return this.reportCards.listByStudent(id); }
}
