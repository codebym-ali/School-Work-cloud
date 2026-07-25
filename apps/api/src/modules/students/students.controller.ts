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
import { StudentsImportService } from './students-import.service';
import { PhoneVerificationService } from './phone-verification.service';
import {
  AddGuardianDto,
  ChangeStudentStatusDto,
  ConfirmOtpDto,
  CreateStudentDto,
  ImportStudentsDto,
  StudentSearchQuery,
  UpdateGuardianDto,
  UpdateStudentDto,
} from './dto/student.dto';

// Directory reads are staff-only (§23, P2.1): parents/students use scoped child/self reads.
// The ADMISSION_CONTROLLER needs the directory + guardian lookup to run admissions, so reads
// include it; CREATING a student, however, is admission-controller-only (see POST handlers).
@Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER')
@Controller('students')
export class StudentsController {
  constructor(
    private readonly students: StudentsService,
    private readonly guardians: GuardiansService,
    private readonly importer: StudentsImportService,
    private readonly phoneVerify: PhoneVerificationService,
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

  // Only the admission controller may ADD a student (segregation of duties, not owner/campus).
  @Roles('ADMISSION_CONTROLLER')
  @Post()
  create(@Body() dto: CreateStudentDto) {
    return this.students.createStudent(dto);
  }

  /** Bulk import from CSV (§22.6). Validates the whole file first; imports all-or-nothing.
   *  Returns a per-row error report; `dryRun:true` validates without writing. */
  @Roles('ADMISSION_CONTROLLER')
  @Post('import')
  importCsv(@Body() dto: ImportStudentsDto) {
    return this.importer.import(dto.csv, dto.dryRun ?? false);
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

  /** Lifecycle status change (suspend / restrict / strike off / restore). Separate from the
   *  profile PATCH because it is an audited event with a mandatory reason. Leaving school is
   *  NOT settable here — that runs through the §15 withdrawal workflow. */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Patch(':id/status')
  changeStatus(@Param('id') id: string, @Body() dto: ChangeStudentStatusDto) {
    return this.students.changeStatus(id, dto);
  }

  // Deleting a student record is owner-only — it is for mis-keyed admissions, not departures
  // (the service refuses once payments or certificates exist).
  @Roles('OWNER_ADMIN')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string) {
    await this.students.softDelete(id);
  }

  /** Send an SMS OTP to a guardian's phone (§14). Verifying turns SMS on for that number. */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post('guardians/:parentId/verify-phone')
  requestOtp(@Param('parentId') parentId: string) {
    return this.phoneVerify.request(parentId);
  }

  /** Confirm the OTP the guardian read back → sets phoneVerifiedAt (§14). */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post('guardians/:parentId/verify-phone/confirm')
  confirmOtp(@Param('parentId') parentId: string, @Body() dto: ConfirmOtpDto) {
    return this.phoneVerify.confirm(parentId, dto.code);
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
