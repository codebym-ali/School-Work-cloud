import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { OwnerWritable, Roles, STAFF_ROLES } from '@common';
import { ProposalsService } from '../approvals/proposals.service';
import { SetupService } from './setup.service';
import {
  ClassListQuery,
  CreateAcademicYearDto,
  CreateCampusDto,
  CreateHolidayDto,
  CreateHolidayRangeDto,
  HolidayListQuery,
  CreateClassDto,
  CreateSectionDto,
  CreateSubjectDto,
  MergeSubjectsDto,
  SetSectionSubjectsDto,
  UpdateClassDto,
  UpdateSectionDto,
  UpdateSubjectDto,
  SectionListQuery,
  UpdateCampusDto,
  UpdateSchoolSettingsDto,
} from './dto/setup.dto';

/**
 * The school's own operating rules (§17.1). Until this existed they could only be changed by a
 * developer writing to the database, so a school could not set its own working week, fee due
 * day, or attendance windows without filing a request.
 */
@OwnerWritable()
@Controller('school-settings')
export class SchoolSettingsController {
  private readonly updateSettings;
  // The owner acts directly; the Ops Admin PROPOSES and the owner approves (ProposalsService).
  constructor(private readonly setup: SetupService, proposals: ProposalsService) {
    this.updateSettings = proposals.action('schoolSettings.update', (patch: Record<string, unknown>) => this.setup.updateSettings(patch),
      (patch) => `Change school settings (${Object.keys(patch).filter((k) => patch[k] !== undefined).join(', ') || 'no fields'})`);
  }

  // Readable by both admin roles — a campus admin needs to know the rules they work under
  // (weekly off, backfill window) even though only the owner may change them.
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Get()
  get() {
    return this.setup.getSettings();
  }

  /** Owner + Ops Admin: these govern money and pay, so the deputy who runs the school day-to-day
   *  may change them on the owner's behalf (audited). Partial — send only what changes. */
  @Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN')
  @Patch()
  update(@Body() dto: UpdateSchoolSettingsDto, @Res({ passthrough: true }) res: Response) {
    // Stored payload drops undefined keys (a class-validator DTO materialises every declared property).
    const patch = Object.fromEntries(Object.entries({ ...dto }).filter(([, v]) => v !== undefined)) as Record<string, unknown>;
    return this.updateSettings(patch, res);
  }
}

@OwnerWritable()
@Controller('academic-years')
export class AcademicYearController {
  private readonly createYear;
  private readonly setCurrentYear;
  constructor(private readonly setup: SetupService, proposals: ProposalsService) {
    this.createYear = proposals.action('academicYear.create', (dto: CreateAcademicYearDto) => this.setup.createAcademicYear(dto), (dto) => `Add academic year ${dto.name}`);
    this.setCurrentYear = proposals.action('academicYear.setCurrent', (p: { id: string }) => this.setup.setCurrentAcademicYear(p.id), () => 'Make a different academic year the current one');
  }

  @Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN')
  @Post()
  create(@Body() dto: CreateAcademicYearDto, @Res({ passthrough: true }) res: Response) {
    return this.createYear(dto, res);
  }

  // Staff-only (Issue 3): a picker every staff screen uses, but a STUDENT portal session must not
  // be able to enumerate the school's structure.
  @Roles(...STAFF_ROLES)
  @Get()
  list() {
    return this.setup.listAcademicYears();
  }

  @Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN')
  @Post(':id/set-current')
  setCurrent(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    return this.setCurrentYear({ id }, res);
  }
}

/**
 * School closures — the calendar (G12).
 *
 * The `holidays` table has been read in five places since the start and written by nothing, so
 * every holiday check found nothing and Eid was a working day. This is the write side.
 *
 * Reading is open to TEACHER as well: it is their calendar too, and a teacher who cannot see the
 * closures is a teacher who turns up at a locked school. Declaring one is admin-only, because a
 * closure changes the month's working-day count and therefore everybody's absence deduction.
 */
@OwnerWritable()
@Controller('holidays')
export class HolidayController {
  constructor(private readonly setup: SetupService) {}

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post()
  create(@Body() dto: CreateHolidayDto) {
    return this.setup.createHoliday(dto);
  }

  /** Winter break in one action. Days already closed are skipped, not fatal (§25.3). */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post('range')
  createRange(@Body() dto: CreateHolidayRangeDto) {
    return this.setup.createHolidayRange(dto);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER')
  @Get()
  list(@Query() q: HolidayListQuery) {
    return this.setup.listHolidays(q);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.setup.deleteHoliday(id);
  }
}

@OwnerWritable()
@Controller('campuses')
export class CampusController {
  constructor(private readonly setup: SetupService) {}

  /**
   * Campus comparison (GAP-11). Owner only: comparing campuses is a school-wide question, and a campus's Ops Admin
   * (like a campus admin) must not see another campus's numbers. Declared before any `:id` route so it is never
   * read as an id.
   */
  @Roles('OWNER_ADMIN')
  @Get('summary')
  summary() {
    return this.setup.campusSummary();
  }

  /** Creating / closing a campus is a school-level act — owner only (the Ops Admin runs one campus). */
  @Roles('OWNER_ADMIN')
  @Post()
  create(@Body() dto: CreateCampusDto) {
    return this.setup.createCampus(dto);
  }

  @Roles(...STAFF_ROLES)
  @Get()
  list() {
    return this.setup.listCampuses();
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCampusDto) {
    return this.setup.updateCampus(id, dto);
  }

  @Roles('OWNER_ADMIN')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.setup.deleteCampus(id);
  }
}

@OwnerWritable()
@Controller('classes')
export class ClassController {
  constructor(private readonly setup: SetupService) {}

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post()
  create(@Body() dto: CreateClassDto) {
    return this.setup.createClass(dto);
  }

  @Roles(...STAFF_ROLES)
  @Get()
  list(@Query() q: ClassListQuery) {
    return this.setup.listClasses(q.campusId);
  }

  /**
   * Every section-subject with no teacher this year, campus-scoped. The list the "Without a
   * teacher" tile counts and the /classes filter narrows by — the SAME server fact /staff reads,
   * so the two screens can no longer disagree (audit Law 4).
   */
  // Oversight data (which subjects have no teacher) — admins only, matching /staff. A campus
  // admin is narrowed to their own campus inside coverageGaps().
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Get('coverage')
  coverage() {
    return this.setup.coverageGaps();
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateClassDto) {
    return this.setup.updateClass(id, dto);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.setup.deleteClass(id);
  }
}

@OwnerWritable()
@Controller('sections')
export class SectionController {
  constructor(private readonly setup: SetupService) {}

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post()
  create(@Body() dto: CreateSectionDto) {
    return this.setup.createSection(dto);
  }

  @Roles(...STAFF_ROLES)
  @Get()
  list(@Query() q: SectionListQuery) {
    return this.setup.listSections(q.classId);
  }

  /** Replace which subjects this section studies (empty ⇒ everything the class offers). */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Put(':id/subjects')
  setSubjects(@Param('id') id: string, @Body() dto: SetSectionSubjectsDto) {
    return this.setup.setSectionSubjects(id, dto.subjectIds);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSectionDto) {
    return this.setup.updateSection(id, dto);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.setup.deleteSection(id);
  }
}

@OwnerWritable()
@Controller('subjects')
export class SubjectController {
  constructor(private readonly setup: SetupService) {}

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post()
  create(@Body() dto: CreateSubjectDto) {
    return this.setup.createSubject(dto);
  }

  // Admin-only: the catalogue now carries teacher-gap counts (oversight), and its screen is
  // admin. Previously no @Roles — open to any authenticated user, the same latent gap the SMS
  // routes had. `list` below is left as-is; other admin screens read it and it carries no gap data.
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Get('catalogue')
  catalogue() {
    return this.setup.subjectCatalogue();
  }

  // Fold drifted names onto one canonical spelling. POST (not PATCH :id) because it acts on a NAME
  // across classes, not a single row, and can delete the duplicates it merges. `dryRun` previews.
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post('merge')
  merge(@Body() dto: MergeSubjectsDto) {
    return this.setup.mergeSubjects(dto);
  }

  @Roles(...STAFF_ROLES)
  @Get()
  list(@Query() q: SectionListQuery) {
    return this.setup.listSubjects(q.classId);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSubjectDto) {
    return this.setup.updateSubject(id, dto);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.setup.deleteSubject(id);
  }
}
