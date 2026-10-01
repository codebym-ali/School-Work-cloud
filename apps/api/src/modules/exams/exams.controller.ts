import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { OwnerWritable, Roles, STAFF_ROLES } from '@common';
import { ProposalsService } from '../approvals/proposals.service';
import { ExamSetupService } from './exam-setup.service';
import { ExamsService } from './exams.service';
import { ReportCardsService } from './report-cards.service';
import { BulkMarksDto, CreateExamDto, CreateTermDto, SetGradeScaleDto } from './dto/exams.dto';

@OwnerWritable()
@Controller('grade-scales')
export class GradeScalesController {
  private readonly setScale;
  // School-wide setup: the owner acts directly; the Ops Admin PROPOSES and the owner approves (ProposalsService).
  constructor(private readonly setup: ExamSetupService, proposals: ProposalsService) {
    this.setScale = proposals.action('gradeScale.set', (dto: SetGradeScaleDto) => this.setup.setGradeScale(dto),
      (dto) => `Change the grade scale (${dto.bands.length} bands)`);
  }
  @Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN') @Put() set(@Body() dto: SetGradeScaleDto, @Res({ passthrough: true }) res: Response) { return this.setScale(dto, res); }
  @Roles(...STAFF_ROLES) @Get() get(@Query('academicYearId') yearId: string) { return this.setup.getGradeScale(yearId); }
}

@OwnerWritable()
@Controller('terms')
export class TermsController {
  private readonly createTerm;
  private readonly deleteTerm;
  constructor(
    private readonly setup: ExamSetupService,
    private readonly reportCards: ReportCardsService,
    proposals: ProposalsService,
  ) {
    this.createTerm = proposals.action('term.create', (dto: CreateTermDto) => this.setup.createTerm(dto), (dto) => `Add term “${dto.name}”`);
    this.deleteTerm = proposals.action('term.delete', (p: { id: string }) => this.setup.deleteTerm(p.id), () => 'Remove a term');
  }

  @Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN') @Post() create(@Body() dto: CreateTermDto, @Res({ passthrough: true }) res: Response) { return this.createTerm(dto, res); }
  @Roles(...STAFF_ROLES) @Get() list(@Query('academicYearId') yearId?: string) { return this.setup.listTerms(yearId); }

  // Remove a term created by mistake. Blocked (409) once exams/report cards reference it.
  @Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN') @Delete(':id') remove(@Param('id') id: string, @Res({ passthrough: true }) res: Response) { return this.deleteTerm({ id }, res); }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post(':id/report-cards/generate')
  generate(@Param('id') id: string) { return this.reportCards.generate(id); }

  // Staff only — a student reads their own via GET /students/:id/report-cards (ownership-checked).
  @Roles(...STAFF_ROLES)
  @Get(':id/report-cards')
  termReportCards(@Param('id') id: string) { return this.reportCards.listByTerm(id); }
}

@OwnerWritable()
@Controller('exams')
export class ExamsController {
  constructor(private readonly exams: ExamsService) {}

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN') @Post() create(@Body() dto: CreateExamDto) { return this.exams.createExam(dto); }
  @Roles(...STAFF_ROLES) @Get() list(@Query('classId') classId?: string, @Query('termId') termId?: string, @Query('campusId') campusId?: string) { return this.exams.listExams(classId, termId, campusId); }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post(':id/open-marks-entry')
  open(@Param('id') id: string) { return this.exams.openMarksEntry(id); }

  // Remove an exam created by mistake. Refuses a published exam or one that already has results (409).
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) { return this.exams.deleteExam(id); }

  @Roles('TEACHER', 'CAMPUS_ADMIN', 'OWNER_ADMIN')
  @Post(':id/results/bulk')
  @HttpCode(HttpStatus.OK)
  enterMarks(@Param('id') id: string, @Body() dto: BulkMarksDto) { return this.exams.enterMarks(id, dto); }

  @Roles(...STAFF_ROLES)
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

  @Get(':id/term-results')
  termResults(@Param('id') id: string) { return this.reportCards.termResultsByStudent(id); }

  @Get(':id/report-cards/:termId/file')
  reportCardFile(@Param('id') id: string, @Param('termId') termId: string) { return this.reportCards.reportCardFileUrl(id, termId); }
}
