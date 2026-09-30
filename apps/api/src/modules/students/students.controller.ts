import type { StudentDocumentType } from '@prisma/client';
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
  Put,
  Query,
} from '@nestjs/common';
import { RequiresMfa, Roles } from '@common';
import { StudentsService } from './students.service';
import { GuardiansService } from './guardians.service';
import { StudentsImportService } from './students-import.service';
import { PhoneVerificationService } from './phone-verification.service';
import {
  AddGuardianDto,
  SetStudentCnicDto,
  ChangeStudentStatusDto,
  ConfirmOtpDto,
  CreateStudentDto,
  ImportStudentsDto,
  StudentSearchQuery,
  StudentSummaryQuery,
  UpdateGuardianContactDto,
  UpdateGuardianDto,
  SetStudentDocumentDto,
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

  /** The Students hub KPI strip (Owner UX 1b) — declared before `:id` so "summary" is never read as an id. */
  @Get('summary')
  summary(@Query() q: StudentSummaryQuery) {
    return this.students.summary(q);
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

  /**
   * A short-lived link to the student's photograph.
   *
   * ⚠️ The key itself is never returned as something fetchable — the profile payload carries
   * `photoKey` as an identifier, and only this route turns it into a URL, for ten minutes. The
   * bucket is private; a permanent link would outlive the reason it was handed out.
   */
  @Get(':id/photo')
  photo(@Param('id') id: string) {
    return this.students.photoUrl(id);
  }

  /** The profile header: placement plus today / attendance / latest term / fees, in one read. */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Get(':id/profile-summary')
  profileSummary(@Param('id') id: string) {
    return this.students.profileSummary(id);
  }

  /** Attendance with the school calendar folded in; `from`/`to` default to the academic year to date. */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Get(':id/attendance-summary')
  attendanceSummary(@Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.students.attendanceSummary(id, from, to);
  }

  /**
   * Record or replace the CNIC after admission — the route the admission screen was already
   * telling officers existed. Also provisions the portal login when the student has none.
   * Admin-only: it changes a live sign-in credential.
   */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Patch(':id/cnic')
  setCnic(@Param('id') id: string, @Body() dto: SetStudentCnicDto) {
    return this.students.setCnic(id, dto.cnic);
  }

  /** Audited reveal of a student's national ID — see `StudentsService.revealCnic`. */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @RequiresMfa()
  @Get(':id/cnic')
  revealCnic(@Param('id') id: string) {
    return this.students.revealCnic(id);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateStudentDto) {
    return this.students.update(id, dto);
  }

  /**
   * The admission checklist: every document type with whatever is recorded against it.
   *
   * ⚠️ ADMISSION_CONTROLLER is included on both routes — they are the role that actually receives
   * paperwork at the counter. The class-level @Roles already permits them to read students; a nav
   * or route stricter than the job is how this codebase has silently deleted capability before
   * (CSV import, /my-attendance, /my-leaves were each unreachable by the only role allowed to use
   * them).
   */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER')
  @Get(':id/documents')
  listDocuments(@Param('id') id: string) {
    return this.students.listDocuments(id);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER')
  @Put(':id/documents/:type')
  setDocument(
    @Param('id') id: string,
    @Param('type') type: StudentDocumentType,
    @Body() dto: SetStudentDocumentDto,
  ) {
    return this.students.setDocument(id, type, dto);
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

  /**
   * ADD is open to the admission officer as well (§8): the guardian is optional at admission,
   * so whoever admitted the student has to be able to finish the record — otherwise deferring
   * is a dead end that only an owner can clear. Editing and removing a guardian stay
   * OWNER/CAMPUS-only, so this widens "complete what you started", not "change the record".
   */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER')
  @Post(':id/guardians')
  @HttpCode(HttpStatus.NO_CONTENT)
  async addGuardian(@Param('id') id: string, @Body() dto: AddGuardianDto) {
    await this.students.addGuardian(id, dto, dto.isPrimary ?? false);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Patch(':id/guardians/:guardianId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async updateGuardian(
    @Param('id') id: string,
    @Param('guardianId') guardianId: string,
    @Body() dto: UpdateGuardianDto,
  ) {
    // ⚠️ `relation` was accepted here and ignored — a 204 with nothing changed. Both fields now apply.
    if (dto.relation) await this.students.setGuardianRelation(id, guardianId, dto.relation);
    if (dto.isPrimary) await this.students.setPrimaryGuardian(id, guardianId);
  }

  /**
   * Correct a guardian's name, phone, email or occupation. Edits the PARENT record, so it applies to
   * every child they are guardian of; a changed phone is unverified again and receives no SMS until
   * verified. Routed through the student so the campus check is the one that guards the profile.
   */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Patch(':id/guardians/:guardianId/contact')
  updateGuardianContact(
    @Param('id') id: string,
    @Param('guardianId') guardianId: string,
    @Body() dto: UpdateGuardianContactDto,
  ) {
    return this.students.updateGuardianContact(id, guardianId, dto);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Delete(':id/guardians/:guardianId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeGuardian(@Param('id') id: string, @Param('guardianId') guardianId: string) {
    await this.students.removeGuardian(id, guardianId);
  }
}
