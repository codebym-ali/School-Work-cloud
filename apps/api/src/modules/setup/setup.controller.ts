import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Roles } from '@common';
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
@Controller('school-settings')
export class SchoolSettingsController {
  constructor(private readonly setup: SetupService) {}

  // Readable by both admin roles — a campus admin needs to know the rules they work under
  // (weekly off, backfill window) even though only the owner may change them.
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Get()
  get() {
    return this.setup.getSettings();
  }

  /** Owner-only: these govern money and pay. Partial — send only what changes. */
  @Roles('OWNER_ADMIN')
  @Patch()
  update(@Body() dto: UpdateSchoolSettingsDto) {
    return this.setup.updateSettings({ ...dto } as Record<string, unknown>);
  }
}

@Controller('academic-years')
export class AcademicYearController {
  constructor(private readonly setup: SetupService) {}

  @Roles('OWNER_ADMIN')
  @Post()
  create(@Body() dto: CreateAcademicYearDto) {
    return this.setup.createAcademicYear(dto);
  }

  @Get()
  list() {
    return this.setup.listAcademicYears();
  }

  @Roles('OWNER_ADMIN')
  @Post(':id/set-current')
  setCurrent(@Param('id') id: string) {
    return this.setup.setCurrentAcademicYear(id);
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

@Controller('campuses')
export class CampusController {
  constructor(private readonly setup: SetupService) {}

  @Roles('OWNER_ADMIN')
  @Post()
  create(@Body() dto: CreateCampusDto) {
    return this.setup.createCampus(dto);
  }

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

@Controller('classes')
export class ClassController {
  constructor(private readonly setup: SetupService) {}

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post()
  create(@Body() dto: CreateClassDto) {
    return this.setup.createClass(dto);
  }

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

@Controller('sections')
export class SectionController {
  constructor(private readonly setup: SetupService) {}

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post()
  create(@Body() dto: CreateSectionDto) {
    return this.setup.createSection(dto);
  }

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

@Controller('subjects')
export class SubjectController {
  constructor(private readonly setup: SetupService) {}

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post()
  create(@Body() dto: CreateSubjectDto) {
    return this.setup.createSubject(dto);
  }

  @Get('catalogue')
  catalogue() {
    return this.setup.subjectCatalogue();
  }

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
