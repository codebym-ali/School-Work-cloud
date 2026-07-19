import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '@common';
import { SetupService } from './setup.service';
import {
  ClassListQuery,
  CreateAcademicYearDto,
  CreateCampusDto,
  CreateClassDto,
  CreateSectionDto,
  CreateSubjectDto,
  SectionListQuery,
  UpdateCampusDto,
} from './dto/setup.dto';

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
}

@Controller('subjects')
export class SubjectController {
  constructor(private readonly setup: SetupService) {}

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post()
  create(@Body() dto: CreateSubjectDto) {
    return this.setup.createSubject(dto);
  }

  @Get()
  list(@Query() q: SectionListQuery) {
    return this.setup.listSubjects(q.classId);
  }
}
