import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  AppError,
  assertCampusAccess,
  AuditActions,
  computeAge,
  effectiveCampusFilter,
  ENV,
  ErrorCodes,
  normalizePkPhone,
  paginate,
  parseSchoolSettings,
  restrictedCampusId,
  TenantContext,
  toSkipTake,
  type Env,
  type Paginated,
} from '@common';
import { AuditService, TenantPrismaService } from '@database';
import { AccessService } from '../access/access.service';
import { SetupService } from '../setup/setup.service';
import { GuardiansService } from './guardians.service';
import type { CreateStudentDto, GuardianResolutionDto, StudentSearchQuery, UpdateStudentDto } from './dto/student.dto';

export interface CreateStudentCoreInput {
  fullName: string;
  gender: CreateStudentDto['gender'];
  dateOfBirth: string;
  classId: string;
  sectionId: string;
  guardian: GuardianResolutionDto;
  grNumber?: string;
  rollNumber?: number; // manual, optional; unique per (section, year)
}

export interface CreatedStudent {
  studentId: string;
  enrollmentId: string;
  parentId: string;
  grNumber: string;
  registrationNo: string;
  rollNumber: number | null;
}

/**
 * Students directory + the shared "create student + guardian + enrollment" core
 * used by both direct add (POST /students) and admissions admit (§8). Placement is
 * ALWAYS via an enrollment scoped to the current academic year (§7) — students are
 * never linked directly to a section.
 */
@Injectable()
export class StudentsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly setup: SetupService,
    private readonly guardians: GuardiansService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  /**
   * Create a Student with its primary guardian and an ACTIVE enrollment in the
   * current year. Runs inside the request transaction (interceptor withTenant),
   * so the whole operation is atomic (blueprint §8 admit transaction).
   */
  async createStudentCore(input: CreateStudentCoreInput): Promise<CreatedStudent> {
    const klass = await this.db.class.findFirst({ where: { id: input.classId } });
    if (!klass) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Class not found');
    // Campus scoping (§22.8, P1.7): a campus-bound admin may only admit into their campus.
    assertCampusAccess(this.ctx.user, klass.campusId);
    const section = await this.db.section.findFirst({ where: { id: input.sectionId } });
    if (!section || section.classId !== input.classId) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Section does not belong to class');
    }

    const academicYearId = await this.setup.requireCurrentYearId();
    await this.assertSectionCapacity(input.sectionId, academicYearId, section.capacity);

    const parentId = await this.guardians.resolveParent(input.guardian);
    // Both human IDs are assigned atomically in this same transaction: GR (student identity)
    // and the admission registration number (the form's reference), each gap-free per school.
    const grNumber = await this.nextGrNumber(input.grNumber);
    const registrationNo = await this.nextRegistrationNo();

    let student;
    try {
      student = await this.db.student.create({
        data: {
          schoolId: this.ctx.requireSchoolId(),
          grNumber,
          registrationNo,
          fullName: input.fullName,
          gender: input.gender,
          dateOfBirth: new Date(input.dateOfBirth),
          createdById: this.ctx.user?.userId,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new AppError(ErrorCodes.GR_NUMBER_TAKEN, HttpStatus.CONFLICT, `GR number ${grNumber} already exists`);
      }
      throw e;
    }

    await this.guardians.link(student.id, parentId, input.guardian.relation, true);

    let enrollment;
    try {
      enrollment = await this.db.studentEnrollment.create({
        data: {
          schoolId: this.ctx.requireSchoolId(),
          studentId: student.id,
          academicYearId,
          campusId: klass.campusId,
          classId: input.classId,
          sectionId: input.sectionId,
          rollNumber: input.rollNumber ?? null,
          status: 'ACTIVE',
        },
      });
    } catch (e) {
      // Unique on (section, year, rollNumber) — a manual roll already used in this section/year.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new AppError(ErrorCodes.ROLL_NUMBER_TAKEN, HttpStatus.CONFLICT, `Roll number ${input.rollNumber} is already used in this section this year`);
      }
      throw e;
    }

    return { studentId: student.id, enrollmentId: enrollment.id, parentId, grNumber, registrationNo, rollNumber: enrollment.rollNumber };
  }

  /** AUTO: atomic per-school counter → gap-free admission registration number (mirrors GR). */
  private async nextRegistrationNo(): Promise<string> {
    const schoolId = this.ctx.requireSchoolId();
    const school = await this.db.school.findFirst({ where: { id: schoolId } });
    if (!school) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'School not found');
    const updated = await this.db.school.update({ where: { id: schoolId }, data: { nextRegistrationNo: { increment: 1 } } });
    return `${school.registrationPrefix}${updated.nextRegistrationNo - 1}`;
  }

  /**
   * Direct admission (blueprint §8, redesigned): the admission controller admits a student in
   * one form — campus/class/section placement + guardian + (optional) portal login — atomically.
   * Gated by the `admissions.admit` module. When a CNIC is supplied, the student portal login is
   * provisioned here (a User(STUDENT) + `cnicHash`), so admission and login are one step.
   */
  async createStudent(dto: CreateStudentDto): Promise<CreatedStudent & { loginProvisioned: boolean }> {
    await this.access.assert('admissions.admit');

    // Campus picker consistency + age soft-warn block against the chosen class.
    const klass = await this.db.class.findFirst({ where: { id: dto.classId } });
    if (!klass) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Class not found');
    if (klass.campusId !== dto.campusId) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Class does not belong to the chosen campus');
    }
    this.assertAgeEligible(klass, dto.dateOfBirth, dto.ageOverride ?? false);

    const created = await this.createStudentCore(dto);

    // Provision the portal login only when a CNIC is given — it is the second factor for the
    // CNIC + registration-no sign-in. No CNIC ⇒ the student is admitted without a login.
    let loginProvisioned = false;
    if (dto.cnic) {
      const user = await this.db.user.create({
        data: {
          schoolId: this.ctx.requireSchoolId(),
          email: `s-${created.registrationNo}@student.local`.toLowerCase(),
          roles: ['STUDENT'],
          status: 'ACTIVE',
        },
      });
      await this.db.student.update({
        where: { id: created.studentId },
        data: { userId: user.id, cnicHash: this.hashCnic(dto.cnic) },
      });
      loginProvisioned = true;
    }

    await this.audit.record({
      action: AuditActions.STUDENT_ADMITTED,
      entityType: 'Student',
      entityId: created.studentId,
      newValue: { grNumber: created.grNumber, ageOverride: dto.ageOverride ?? false, loginProvisioned },
    });

    return { ...created, loginProvisioned };
  }

  /** Age-eligibility soft-warn block (§8): out-of-range ⇒ 422 unless the controller overrides. */
  private assertAgeEligible(klass: { minAgeYears: number | null; maxAgeYears: number | null }, dob: string, override: boolean): void {
    if (klass.minAgeYears == null && klass.maxAgeYears == null) return;
    const age = computeAge(new Date(dob));
    const below = klass.minAgeYears != null && age < klass.minAgeYears;
    const above = klass.maxAgeYears != null && age > klass.maxAgeYears;
    if ((below || above) && !override) {
      throw new AppError(
        ErrorCodes.AGE_OUT_OF_RANGE,
        HttpStatus.UNPROCESSABLE_ENTITY,
        `Student age ${age} is outside this class's range (${klass.minAgeYears ?? '—'}–${klass.maxAgeYears ?? '—'})`,
        [{ field: 'dateOfBirth', issue: `computedAge=${age};min=${klass.minAgeYears ?? ''};max=${klass.maxAgeYears ?? ''}` }],
      );
    }
  }

  /** HMAC of the normalized CNIC/B-Form — the stored second factor (never plaintext). */
  private hashCnic(cnic: string): string {
    const normalized = cnic.replace(/\D/g, '');
    return createHmac('sha256', this.env.ENCRYPTION_MASTER_KEY).update(normalized).digest('hex');
  }

  // ── Directory ────────────────────────────────────────────────────────────────
  async search(q: StudentSearchQuery): Promise<Paginated<unknown>> {
    const where: Prisma.StudentWhereInput = { deletedAt: null };
    if (q.status) where.isActive = q.status === 'ACTIVE';

    // Campus scoping (§22.8, P1.7): a campus-bound admin's campus is FORCED here,
    // overriding any client-supplied `campusId`; OWNER_ADMIN keeps the client filter.
    const campusId = effectiveCampusFilter(this.ctx.user, q.campusId);
    const enroll: Prisma.StudentEnrollmentWhereInput = { status: 'ACTIVE' };
    if (campusId) enroll.campusId = campusId;
    if (q.classId) enroll.classId = q.classId;
    if (q.sectionId) enroll.sectionId = q.sectionId;
    if (campusId || q.classId || q.sectionId) where.enrollments = { some: enroll };

    if (q.search) {
      const phone = normalizePkPhone(q.search);
      if (phone) {
        where.guardians = { some: { parent: { phone } } };
      } else {
        where.OR = [
          { grNumber: q.search },
          { fullName: { contains: q.search, mode: 'insensitive' } },
        ];
      }
    }

    const { skip, take } = toSkipTake(q);
    const [rows, total] = await Promise.all([
      this.db.student.findMany({
        where,
        skip,
        take,
        orderBy: { fullName: 'asc' },
        include: {
          enrollments: {
            where: { status: 'ACTIVE' },
            select: { id: true, classId: true, sectionId: true, campusId: true, rollNumber: true },
            take: 1,
          },
        },
      }),
      this.db.student.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  async getOne(id: string) {
    const student = await this.db.student.findFirst({
      where: { id, deletedAt: null },
      include: {
        guardians: { include: { parent: { select: { id: true, fullName: true, phone: true } } } },
        enrollments: { orderBy: { startedAt: 'desc' } },
      },
    });
    if (!student) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Student not found');
    // Campus scoping (§22.8, P1.7): a campus-bound admin may only reach a student who
    // has an ACTIVE enrollment in their campus. Gates detail read + update/delete +
    // every guardian op (all route through getOne).
    const restricted = restrictedCampusId(this.ctx.user);
    if (restricted !== null && !student.enrollments.some((e) => e.status === 'ACTIVE' && e.campusId === restricted)) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Student belongs to another campus');
    }
    return student;
  }

  async update(id: string, dto: UpdateStudentDto) {
    await this.getOne(id);
    return this.db.student.update({
      where: { id },
      data: {
        fullName: dto.fullName,
        gender: dto.gender,
        dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
      },
    });
  }

  /**
   * Soft delete (blueprint §17 — no hard cascade delete exists in the product). Also closes
   * any still-ACTIVE enrollment: an open enrollment is what every downstream read counts as a
   * seated student, so leaving it behind kept a removed student on class rosters, in the
   * dashboard head-count, and — worst — in fee-invoice batches (they kept getting billed).
   */
  async softDelete(id: string): Promise<void> {
    await this.getOne(id);
    await this.db.student.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
    await this.db.studentEnrollment.updateMany({
      where: { studentId: id, status: 'ACTIVE' },
      data: { status: 'WITHDRAWN', endedAt: new Date() },
    });
  }

  // ── GR number + capacity ─────────────────────────────────────────────────────
  private async nextGrNumber(manual?: string): Promise<string> {
    const schoolId = this.ctx.requireSchoolId();
    const school = await this.db.school.findFirst({ where: { id: schoolId } });
    if (!school) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'School not found');

    if (school.grNumberMode === 'MANUAL') {
      if (!manual) throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'grNumber is required in MANUAL mode');
      return manual;
    }
    // AUTO: atomic increment; the assigned number is the pre-increment value.
    const updated = await this.db.school.update({
      where: { id: schoolId },
      data: { nextGrNumber: { increment: 1 } },
    });
    return `${school.grPrefix}${updated.nextGrNumber - 1}`;
  }

  private async assertSectionCapacity(sectionId: string, academicYearId: string, capacity: number): Promise<void> {
    const settings = parseSchoolSettings((await this.currentSchoolSettings()) ?? {});
    if (settings.sectionCapacityMode !== 'HARD') return; // ADVISORY: allow (UI warns)
    const count = await this.db.studentEnrollment.count({
      where: { sectionId, academicYearId, status: 'ACTIVE' },
    });
    if (count >= capacity) {
      throw new AppError(ErrorCodes.SECTION_FULL, HttpStatus.UNPROCESSABLE_ENTITY, 'Section is at capacity');
    }
  }

  private async currentSchoolSettings(): Promise<unknown> {
    const school = await this.db.school.findFirst({ where: { id: this.ctx.requireSchoolId() } });
    return school?.settings;
  }

  // ── Guardian passthroughs (student-scoped) ───────────────────────────────────
  async addGuardian(studentId: string, res: GuardianResolutionDto, isPrimary: boolean): Promise<void> {
    await this.getOne(studentId);
    const parentId = await this.guardians.resolveParent(res);
    await this.guardians.link(studentId, parentId, res.relation, isPrimary);
  }

  async setPrimaryGuardian(studentId: string, linkId: string): Promise<void> {
    await this.getOne(studentId);
    await this.guardians.setPrimary(studentId, linkId);
  }

  async removeGuardian(studentId: string, linkId: string): Promise<void> {
    await this.getOne(studentId);
    await this.guardians.remove(studentId, linkId);
  }
}
