import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { Prisma, StudentStatus } from '@prisma/client';
import {
  AppError,
  assertCampusAccess,
  AuditActions,
  computeAge,
  effectiveCampusFilter,
  ENV,
  FIELD_ENCRYPTION,
  FieldEncryption,
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
import type { ChangeStudentStatusDto, CreateStudentDto, GuardianResolutionDto, StudentSearchQuery, UpdateStudentDto } from './dto/student.dto';

export interface CreateStudentCoreInput {
  fullName: string;
  gender: CreateStudentDto['gender'];
  dateOfBirth: string;
  classId: string;
  sectionId: string;
  /** Optional (§8) — a walk-in may be seated before the guardian's details are collected. */
  guardian?: GuardianResolutionDto;
  grNumber?: string;
  rollNumber?: number; // manual, optional; unique per (section, year)
}

export interface CreatedStudent {
  studentId: string;
  enrollmentId: string;
  /** null when the student was admitted without a guardian — chase it via `hasGuardian`. */
  parentId: string | null;
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
    @Inject(FIELD_ENCRYPTION) private readonly crypto: FieldEncryption,
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

    // Resolved only when a guardian was actually supplied — admitting without one is allowed
    // and leaves zero `student_guardians` rows, which every downstream reader already handles
    // (SMS dispatch and advance auto-application both bail out on a missing primary guardian).
    const parentId = input.guardian ? await this.guardians.resolveParent(input.guardian) : null;
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

    // The first guardian is the primary one. Skipped entirely when none was given.
    if (parentId && input.guardian) {
      await this.guardians.link(student.id, parentId, input.guardian.relation, true);
    }

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
        // Both forms of the same id: the HASH verifies a login attempt, the CIPHERTEXT lets an
        // admin read the number back (audited). Neither can substitute for the other.
        data: { userId: user.id, cnicHash: this.hashCnic(dto.cnic), cnicEnc: this.crypto.encrypt(dto.cnic) },
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
    if (q.status) where.status = q.status === 'INACTIVE' ? { not: StudentStatus.ACTIVE } : q.status;

    // Campus scoping (§22.8, P1.7): a campus-bound admin's campus is FORCED here,
    // overriding any client-supplied `campusId`; OWNER_ADMIN keeps the client filter.
    const campusId = effectiveCampusFilter(this.ctx.user, q.campusId);
    const enroll: Prisma.StudentEnrollmentWhereInput = { status: 'ACTIVE' };
    if (campusId) enroll.campusId = campusId;
    if (q.classId) enroll.classId = q.classId;
    if (q.sectionId) enroll.sectionId = q.sectionId;
    if (campusId || q.classId || q.sectionId) where.enrollments = { some: enroll };
    // The chase list for students admitted without a guardian (§8) — they receive no SMS at
    // all, so being able to find them is what keeps "record it later" from meaning "never".
    if (q.missingGuardian === 'true') where.guardians = { none: {} };

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
          // Presence only — a count, not the guardian rows, so the directory payload doesn't
          // grow just to answer "is anyone contactable for this child?".
          _count: { select: { guardians: true } },
        },
      }),
      this.db.student.count({ where }),
    ]);
    // `hasGuardian` is surfaced on every row so the UI can flag a student nobody can be
    // contacted about — without it, admitting without a guardian is an invisible dead end.
    const data = rows.map(({ _count, ...s }) => ({ ...s, hasGuardian: _count.guardians > 0 }));
    return paginate(data, total, q);
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
    // Neither secret column ever leaves in a profile payload: the hash is a login factor and
    // the ciphertext is only for the audited reveal. The profile carries presence, not value.
    const { cnicHash, cnicEnc, ...rest } = student;
    return {
      ...rest,
      hasCnic: Boolean(cnicEnc ?? cnicHash),
      /** Whether this student can sign in to the read-only portal (reg-no + CNIC). */
      portalLoginEnabled: Boolean(student.userId),
      /** A CNIC recorded before the encrypted column existed can be matched at login but not
       *  read back — so the UI can explain that instead of implying the number was lost. */
      cnicRevealable: Boolean(cnicEnc),
    };
  }

  /**
   * Decrypt and return a student's CNIC/B-Form (OWNER/CAMPUS_ADMIN — the route gates the role,
   * `getOne` gates the campus).
   *
   * Deliberately NOT a field on the profile: reading a child's national ID is an event, and if
   * it rode along with every profile load there would be nothing meaningful to audit. So the
   * reveal is its own call, and every one of them is recorded.
   */
  async revealCnic(id: string): Promise<{ cnic: string }> {
    const student = await this.getOne(id); // 404 + campus scope, before anything is decrypted
    const row = await this.db.student.findFirst({ where: { id }, select: { cnicEnc: true, cnicHash: true } });
    if (!row?.cnicEnc) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        HttpStatus.NOT_FOUND,
        row?.cnicHash
          ? 'This CNIC was recorded before it could be stored readably — it can verify a login but cannot be shown. Re-enter it to make it readable.'
          : 'No CNIC on record for this student',
      );
    }

    await this.audit.record({
      action: AuditActions.STUDENT_CNIC_REVEALED,
      entityType: 'Student',
      entityId: id,
      // Identity, not the value — an audit trail must never become a second copy of the secret.
      newValue: { fullName: student.fullName, grNumber: student.grNumber },
    });

    return { cnic: this.crypto.decrypt(row.cnicEnc) };
  }

  /**
   * Record or replace a student's CNIC/B-Form after admission, provisioning the portal login if
   * they don't have one yet.
   *
   * This closes a gap the admission screen had been advertising: it told the officer to "add a
   * CNIC later" while no route existed to do it, so a student admitted without one could never
   * get a portal login. It also unblocks students recorded before `cnic_enc` existed — their
   * hash can verify a sign-in but can never be read back, and re-entering the number is the
   * only way to make it revealable.
   *
   * Replacing an existing CNIC **changes a live credential**: the student signs in with
   * registration-no + CNIC, so the old number stops working immediately. Hence the audit entry
   * records whether this was a first capture or a replacement — never the value itself.
   */
  async setCnic(id: string, cnic: string) {
    const student = await this.getOne(id); // 404 + campus scope
    const row = await this.db.student.findFirst({
      where: { id },
      select: { userId: true, cnicHash: true, registrationNo: true },
    });
    if (!row) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Student not found');

    const hash = this.hashCnic(cnic);
    // Another student signing in with this number would be ambiguous — the portal resolves a
    // login by (registrationNo, cnicHash), so a duplicate is a data-entry error worth naming.
    const clash = await this.db.student.findFirst({
      where: { cnicHash: hash, deletedAt: null, NOT: { id } },
      select: { fullName: true, grNumber: true },
    });
    if (clash) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        HttpStatus.CONFLICT,
        `This CNIC is already recorded for ${clash.fullName} (GR ${clash.grNumber}). Check the number before saving.`,
      );
    }

    const replaced = Boolean(row.cnicHash);
    let loginProvisioned = false;

    await this.db.student.update({
      where: { id },
      data: { cnicHash: hash, cnicEnc: this.crypto.encrypt(cnic) },
    });

    // Mirrors the admission path exactly, so a login created later is indistinguishable from
    // one created at admission.
    if (!row.userId) {
      const user = await this.db.user.create({
        data: {
          schoolId: this.ctx.requireSchoolId(),
          email: `s-${row.registrationNo}@student.local`.toLowerCase(),
          roles: ['STUDENT'],
          status: 'ACTIVE',
        },
      });
      await this.db.student.update({ where: { id }, data: { userId: user.id } });
      loginProvisioned = true;
    }

    await this.audit.record({
      action: AuditActions.STUDENT_CNIC_SET,
      entityType: 'Student',
      entityId: id,
      // Identity and the nature of the change — never the number.
      newValue: {
        fullName: student.fullName,
        grNumber: student.grNumber,
        replacedExisting: replaced,
        loginProvisioned,
      },
    });

    return { loginProvisioned, replacedExisting: replaced, registrationNo: row.registrationNo };
  }

  async update(id: string, dto: UpdateStudentDto) {
    const before = await this.getOne(id);
    const updated = await this.db.student.update({
      where: { id },
      data: {
        fullName: dto.fullName,
        gender: dto.gender,
        dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
      },
    });
    await this.audit.record({
      action: AuditActions.STUDENT_UPDATED,
      entityType: 'Student',
      entityId: id,
      oldValue: { fullName: before.fullName, gender: before.gender, dateOfBirth: before.dateOfBirth },
      newValue: { fullName: updated.fullName, gender: updated.gender, dateOfBirth: updated.dateOfBirth },
    });
    return updated;
  }

  // ── Lifecycle status ─────────────────────────────────────────────────────────

  /**
   * Legal status transitions. WITHDRAWN is absent as a target everywhere: leaving school
   * runs through the §15 withdrawal workflow (fee clearance + leaving certificate), and
   * letting it be set directly here would skip both. WITHDRAWN/GRADUATED are terminal —
   * a returning student is a fresh admission, not a status flip.
   */
  private static readonly STATUS_TRANSITIONS: Record<StudentStatus, StudentStatus[]> = {
    ACTIVE: [StudentStatus.SUSPENDED, StudentStatus.RESTRICTED, StudentStatus.STRUCK_OFF, StudentStatus.GRADUATED],
    SUSPENDED: [StudentStatus.ACTIVE, StudentStatus.RESTRICTED, StudentStatus.STRUCK_OFF],
    RESTRICTED: [StudentStatus.ACTIVE, StudentStatus.SUSPENDED, StudentStatus.STRUCK_OFF],
    STRUCK_OFF: [StudentStatus.ACTIVE], // re-admission
    WITHDRAWN: [],
    GRADUATED: [],
  };

  /** Statuses that end the student's seat. SUSPENDED and RESTRICTED deliberately do not:
   *  the seat is held (and still billed) through a suspension, and a restricted student
   *  is still attending class — only their portal access is revoked. */
  private static readonly SEAT_ENDING: StudentStatus[] = [StudentStatus.STRUCK_OFF, StudentStatus.GRADUATED];

  async changeStatus(id: string, dto: ChangeStudentStatusDto) {
    const student = await this.getOne(id);
    const from = student.status;
    const to = dto.status;

    if (from === to) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, `Student is already ${to}`);
    }
    if (!StudentsService.STATUS_TRANSITIONS[from].includes(to)) {
      const hint = to === StudentStatus.WITHDRAWN
        ? 'Use the withdrawal workflow so fee clearance and the leaving certificate are issued'
        : `Allowed from ${from}: ${StudentsService.STATUS_TRANSITIONS[from].join(', ') || 'none (terminal)'}`;
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, `Cannot change status from ${from} to ${to}. ${hint}`);
    }

    const effectiveFrom = dto.effectiveFrom ? new Date(dto.effectiveFrom) : new Date();
    const endsOn = to === StudentStatus.SUSPENDED && dto.endsOn ? new Date(dto.endsOn) : null;
    if (endsOn && endsOn <= effectiveFrom) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY,
        'Suspension end date must be after it starts', [{ field: 'endsOn', issue: 'before-start' }]);
    }

    const updated = await this.db.student.update({
      where: { id },
      data: {
        status: to,
        statusReason: dto.reason,
        statusEffectiveFrom: effectiveFrom,
        statusEndsOn: endsOn,
        isActive: to === StudentStatus.ACTIVE, // derived mirror, kept in step
      },
    });

    if (StudentsService.SEAT_ENDING.includes(to)) {
      await this.db.studentEnrollment.updateMany({
        where: { studentId: id, status: 'ACTIVE' },
        data: { status: to === StudentStatus.GRADUATED ? 'COMPLETED' : 'WITHDRAWN', endedAt: effectiveFrom },
      });
    }

    // The portal login mirrors the status: RESTRICTED loses access outright, SUSPENDED keeps
    // it (they still need to see the notice and their fees) and sees a banner instead.
    if (student.userId) {
      const disabled = to === StudentStatus.RESTRICTED || StudentsService.SEAT_ENDING.includes(to);
      await this.db.user.update({ where: { id: student.userId }, data: { status: disabled ? 'DISABLED' : 'ACTIVE' } });
    }

    await this.audit.record({
      action: AuditActions.STUDENT_STATUS_CHANGED,
      entityType: 'Student',
      entityId: id,
      oldValue: { status: from },
      newValue: { status: to, endsOn: endsOn?.toISOString() ?? null },
      reason: dto.reason,
    });

    return updated;
  }

  /**
   * Soft delete (blueprint §17 — no hard cascade delete exists in the product). Also closes
   * any still-ACTIVE enrollment: an open enrollment is what every downstream read counts as a
   * seated student, so leaving it behind kept a removed student on class rosters, in the
   * dashboard head-count, and — worst — in fee-invoice batches (they kept getting billed).
   *
   * Delete means "this record should never have existed" (duplicate/mis-keyed admission).
   * Once money or a certificate is attached to the student, deleting would break the
   * accounting trail, so it is refused and the caller is pointed at withdrawal instead.
   */
  async softDelete(id: string): Promise<void> {
    const student = await this.getOne(id);

    const paid = await this.db.feePayment.findFirst({ where: { invoice: { studentId: id } }, select: { id: true } });
    const doc = await this.db.document.findFirst({ where: { studentId: id }, select: { id: true } });
    if (paid || doc) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        HttpStatus.CONFLICT,
        'This student has payment or certificate history and cannot be deleted. Withdraw them instead so the record is kept.',
        [{ field: 'id', issue: paid ? 'has-payments' : 'has-documents' }],
      );
    }

    await this.db.student.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
    await this.db.studentEnrollment.updateMany({
      where: { studentId: id, status: 'ACTIVE' },
      data: { status: 'WITHDRAWN', endedAt: new Date() },
    });

    // Removing a child's record is the most consequential action in the product and was
    // leaving no trace at all. oldValue carries the identifying fields so the trail still
    // says WHO was removed once the row is filtered out of every read.
    await this.audit.record({
      action: AuditActions.STUDENT_DELETED,
      entityType: 'Student',
      entityId: id,
      oldValue: {
        fullName: student.fullName,
        grNumber: student.grNumber,
        registrationNo: student.registrationNo,
        status: student.status,
      },
      newValue: { deleted: true },
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
