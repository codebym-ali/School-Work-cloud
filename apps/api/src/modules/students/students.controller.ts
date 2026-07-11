import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Roles } from '@common';
import { StudentsService } from './students.service';
import { GuardiansService } from './guardians.service';
import {
  AddGuardianDto,
  CreateStudentDto,
  StudentSearchQuery,
  UpdateGuardianDto,
  UpdateStudentDto,
} from './dto/student.dto';

// Directory is admin-only (§23, P2.1): parents/students use scoped child/self reads.
@Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
@Controller('students')
export class StudentsController {
  constructor(
    private readonly students: StudentsService,
    private readonly guardians: GuardiansService,
  ) {}

  @Get()
  search(@Query() q: StudentSearchQuery) {
    return this.students.search(q);
  }

  /** Existing-parent lookup by phone for the admit "link?" step (§8). */
  @Get('parents/search')
  findParents(@Query('phone') phone: string) {
    return this.guardians.findByPhone(phone ?? '');
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post()
  create(@Body() dto: CreateStudentDto) {
    return this.students.createStudent(dto);
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.students.getOne(id);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateStudentDto) {
    return this.students.update(id, dto);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string) {
    await this.students.softDelete(id);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post(':id/guardians')
  @HttpCode(HttpStatus.NO_CONTENT)
  async addGuardian(@Param('id') id: string, @Body() dto: AddGuardianDto) {
    await this.students.addGuardian(id, dto, dto.isPrimary ?? false);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Patch(':id/guardians/:gid')
  @HttpCode(HttpStatus.NO_CONTENT)
  async updateGuardian(
    @Param('id') id: string,
    @Param('gid') gid: string,
    @Body() dto: UpdateGuardianDto,
  ) {
    if (dto.isPrimary) await this.students.setPrimaryGuardian(id, gid);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Delete(':id/guardians/:gid')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeGuardian(@Param('id') id: string, @Param('gid') gid: string) {
    await this.students.removeGuardian(id, gid);
  }
}
