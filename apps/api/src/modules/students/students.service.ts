import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { Prisma, StudentStatus, type GuardianRelation, type StudentDocumentType } from '@prisma/client';
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
  restrictedCampusId,
  StorageService,
  TenantContext,
  toSkipTake,
  type Env,
  type Paginated,
} from '@common';
import { AuditService, TenantPrismaService } from '@database';
import { AccessService } from '../access/access.service';
import { SetupService } from '../setup/setup.service';
import { GuardiansService } from './guardians.service';
import type { ChangeStudentStatusDto, CreateStudentDto, GuardianResolutionDto, SetStudentDocumentDto, StudentSearchQuery, UpdateGuardianContactDto, UpdateStudentDto } from './dto/student.dto';

export interface CreateStudentCoreInput {
  fullName: string;
  gender: CreateStudentDto['gender'];
  dateOfBirth: string;
  classId: string;
  sectionId: string;
  /** Optional (§8) — a walk-in may be seated before the guardian's details are collected. */
  guardian?: GuardianResolutionDto;
  /** Father, Mother, and anyone else. Wins over `guardian`; the FIRST is the primary. */
  guardians?: GuardianResolutionDto[];
  religion?: string;
  addressLine?: string;
  city?: string;
  emergencyName?: string;
  emergencyPhone?: string;
  emergencyRelation?: string;
  /** Object key of the photograph, from the presigned upload. Optional at admission by design —
   *  seating a walk-in in under a minute is the form's whole virtue, and a camera is not always to
   *  hand. It can be attached later from the profile. */
  photoKey?: string;
  grNumber?: string;
  rollNumber?: number; // manual, optional; unique per (section, year)
  /** Office-set joining date (YYYY-MM-DD). Omitted ⇒ today, so CSV import and the pipeline
   *  admit are unchanged. Lands on `StudentEnrollment.startedAt`. */
  admissionDate?: string;
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
/**
 * Human labels for the admission checklist. Rendered to an admissions officer, so they read the way
 * the office speaks — "B-Form", not "B_FORM".
 */
export const DOCUMENT_LABELS: Record<StudentDocumentType, string> = {
  B_FORM: 'B-Form',
  BIRTH_CERTIFICATE: 'Birth certificate',
  GUARDIAN_CNIC: "Guardian's CNIC",
  PREV_SCHOOL_LEAVING: 'School leaving certificate',
  PREV_REPORT_CARD: 'Previous report card',
  PHOTOGRAPH: 'Photograph',
  MEDICAL_RECORD: 'Medical record',
  OTHER: 'Other document',
};

/**
 * The documents whose absence makes a record INCOMPLETE — deliberately two, not eight.
 *
 * ⚠️ Same discipline as the rest of `recordGaps`: a chase list that cannot reach zero trains people
 * to ignore it. Only documents that (a) every student has and (b) a front desk can actually obtain
 * qualify.
 *
 *  - **Leaving certificate is excluded.** It applies to transfers only; a child starting in KG has
 *    none, and flagging them forever would be flagging the truth as an error. It is still tracked on
 *    the checklist, and `slcReceived` already surfaces the withheld-by-previous-school case.
 *  - **Photograph is excluded.** The canonical digital photo is `students.photoKey`; the checklist
 *    entry records a hard copy for the physical file, which not every school keeps.
 *  - **Birth certificate is excluded** because in practice the B-Form IS the identity document; a
 *    family that has produced one is rarely asked for the other.
 */
export const MANDATORY_DOCUMENTS: StudentDocumentType[] = ['B_FORM', 'GUARDIAN_CNIC'];

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
    private readonly storage: StorageService,
  ) {}

  /**
   * A short-lived link to the student's photograph, for display.
   *
   * ⚠️ **No `filename` argument, and that is the whole difference between working and not.**
   * `presignGet`'s third parameter sets `Content-Disposition: attachment`, which tells the browser
   * to DOWNLOAD the object — correct for a payment proof, fatal for an `<img src>`, where it
   * renders nothing and reports no error. Every other caller in the codebase passes it.
   *
   * ⚠️ Routed through `getOne` so the campus check is the SAME one that guards the profile. A photo
   * endpoint with its own weaker check would be a way to read across campuses one child at a time.
   */
  async photoUrl(id: string): Promise<{ url: string; expiresInSeconds: number }> {
    const student = await this.getOne(id);
    if (!student.photoKey) {
      throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'No photograph on file for this student');
    }
    const expiresInSeconds = 600;
    return { url: await this.storage.presignGet(student.photoKey, expiresInSeconds), expiresInSeconds };
  }

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

    /**
     * The office-set joining date (Tier 1). Defaults to today when the form does not send one, so
     * existing callers — CSV import, the pipeline admit — are unchanged.
     *
     * ⚠️ **A future date is refused, not clamped.** The enrolment is what the register, the fee
     * proration and the seniority list all read; admitting someone as starting next month would
     * open a register they cannot be marked on and bill from a day that has not happened. Refusing
     * says so; silently moving it to today would hide a keying error that only surfaces as a
     * wrong invoice weeks later.
     */
    const startedAt = input.admissionDate ? new Date(input.admissionDate) : undefined;
    if (startedAt) {
      const endOfToday = new Date();
      endOfToday.setUTCHours(23, 59, 59, 999);
      if (startedAt.getTime() > endOfToday.getTime()) {
        throw new AppError(
          ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY,
          'Admission date cannot be in the future',
        );
      }
    }

    const academicYearId = await this.setup.requireCurrentYearId();
    // Owned by SetupService so admission and transfer cannot disagree about a full section —
    // this used to be private here, which is precisely why `/enrollments/transfer` never had it.
    await this.setup.assertSectionHasRoom(input.sectionId, academicYearId, section.capacity);

    /**
     * Resolved only when a guardian was actually supplied — admitting without one is allowed and
     * leaves zero `student_guardians` rows, which every downstream reader already handles (SMS
     * dispatch and advance auto-application both bail out on a missing primary guardian).
     *
     * ⚠️ **Resolved BEFORE the student row is written, and all of them.** A bad guardian (an
     * unparseable phone, a LINK to a parent that does not exist, a CREATE whose phone already
     * belongs to someone) must fail before a child exists — otherwise a half-admitted student is
     * left behind holding a GR number that can never be reused. The whole method runs in the
     * request transaction, so a throw here rolls the lot back either way; doing it in this order
     * means the failure names the guardian rather than a constraint.
     *
     * `guardians` (Father + Mother + …) wins over the single `guardian`, which CSV import and the
     * pipeline admit still send. The FIRST is the primary — the one every SMS and receipt resolves.
     */
    const guardianList = input.guardians?.length ? input.guardians : input.guardian ? [input.guardian] : [];
    const resolvedGuardians: { parentId: string; relation: GuardianResolutionDto['relation'] }[] = [];
    for (const g of guardianList) {
      resolvedGuardians.push({ parentId: await this.guardians.resolveParent(g), relation: g.relation });
    }
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
          // Admission-record fields (Tier 1). `?? null` rather than omitted so an empty form field
          // clears a value on the way through rather than leaving a stale one.
          religion: input.religion ?? null,
          addressLine: input.addressLine ?? null,
          city: input.city ?? null,
          emergencyName: input.emergencyName ?? null,
          emergencyPhone: input.emergencyPhone ?? null,
          emergencyRelation: input.emergencyRelation ?? null,
          photoKey: input.photoKey ?? null,
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
    // `link` enforces one primary per student and refuses the same parent twice, so a form that
    // sends the same person as both Father and Guardian gets a clean 409 rather than two rows.
    for (const [i, g] of resolvedGuardians.entries()) {
      await this.guardians.link(student.id, g.parentId, g.relation, i === 0);
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
          // Omitted (not null) when unset, so the column's `now()` default still applies.
          ...(startedAt ? { startedAt } : {}),
        },
      });
    } catch (e) {
      // Unique on (section, year, rollNumber) — a manual roll already used in this section/year.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new AppError(ErrorCodes.ROLL_NUMBER_TAKEN, HttpStatus.CONFLICT, `Roll number ${input.rollNumber} is already used in this section this year`);
      }
      throw e;
    }

    // Still the PRIMARY parent, so every existing caller means the same thing by it as before.
    const parentId = resolvedGuardians[0]?.parentId ?? null;
    return { studentId: student.id, enrollmentId: enrollment.id, parentId, grNumber, registrationNo, rollNumber: enrollment.rollNumber };
  }

  /** AUTO: atomic per-school counter → gap-free admission registration number (mirrors GR). */
  private async nextRegistrationNo(): Promise<string> {
    const schoolId = this.ctx.requireSchoolId();
    const school = await this.db.school.findFirst({ where: { id: schoolId } });
    if (!school) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'School not found');
    const updated = await this.db.school.update({ where: { id: schoolId }, data: { nextRegistrationNo: { increment: 1 } } });
    // Zero-padded so the sequence sorts and reads as a real register (REG-2026-0031, not REG-2026-31).
    return `${school.registrationPrefix}${String(updated.nextRegistrationNo - 1).padStart(4, '0')}`;
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
          // Two small columns, not the whole row: enough to answer "is the paperwork in?" on the
          // directory, without the note/fileKey a list never renders.
          documents: { select: { type: true, received: true } },
        },
      }),
      this.db.student.count({ where }),
    ]);
    // `hasGuardian` is surfaced on every row so the UI can flag a student nobody can be
    // contacted about — without it, admitting without a guardian is an invisible dead end.
    const data = rows.map(({ _count, documents, ...s }) => ({
      ...s,
      hasGuardian: _count.guardians > 0,
      documentsComplete: MANDATORY_DOCUMENTS.every((t) => documents.some((d) => d.type === t && d.received)),
      // Same shape as `hasGuardian`: a derived flag the directory can badge, so an incomplete
      // record is chased from the list rather than found one profile at a time.
      recordComplete: StudentsService.recordGaps(s, _count.guardians).length === 0,
    }));
    return paginate(data, total, q);
  }

  async getOne(id: string) {
    const student = await this.db.student.findFirst({
      where: { id, deletedAt: null },
      include: {
        guardians: {
          // Primary first: it is the one every receipt and SMS resolves, so it leads the card.
          orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
          include: {
            parent: {
              select: {
                id: true, fullName: true, phone: true, email: true, occupation: true, phoneVerifiedAt: true,
                // How many children this guardian covers, so an edit can say who else it changes.
                _count: { select: { guardianLinks: true } },
              },
            },
          },
        },
        enrollments: { orderBy: { startedAt: 'desc' } },
        documents: { orderBy: { type: 'asc' } },
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
      /**
       * What is still missing from this record, as labels an admissions officer can act on.
       *
       * The other half of "admit fast, then complete the record": a walk-in is deliberately seated
       * with almost nothing on file, and without a list saying what is outstanding, "later" means
       * "never". Narrow by design — see `recordGaps`.
       */
      missingFields: StudentsService.recordGaps(student, student.guardians.length),
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

  /**
   * What is still missing from a student's record — the "chase list" (Admission Form Field Gaps).
   *
   * ⚠️ **Deliberately narrow, and that is the whole design.** A completeness flag that can never
   * reach zero trains people to ignore it, so this contains ONLY fields that are (a) applicable to
   * every student and (b) actually obtainable at a front desk:
   *
   *  - **Previous school is excluded.** A child starting in KG has none, and flagging them forever
   *    would be flagging the truth as an error.
   *  - **Blood group and medical notes are excluded.** A parent may genuinely not know the blood
   *    group, and "no known conditions" is indistinguishable from "nobody asked" in a text column.
   *    Both are still *shown* on the profile so the office can fill them; they just do not make a
   *    record permanently incomplete.
   *  - **Guardian is included** — it already had its own flag (`hasGuardian`), and a student nobody
   *    can be contacted about is the most consequential gap of all.
   *
   * Returns human labels, not field names: this list is rendered to an admissions officer.
   *
   * ⚠️ **Documents are deliberately NOT in here.** Folding the checklist into `recordComplete` was
   * tried and reverted: it silently redefines what "complete" has always meant (the three existing
   * specs assert the list empties once the TEXT fields are filled), and on a live school it would
   * mark every already-admitted student incomplete overnight — a list nobody can empty, which is
   * exactly the failure this comment block warns about. Documents get their own signal,
   * `documentsComplete` on the directory row, and their own card on the profile.
   */
  /**
   * The admission checklist for one student: EVERY document type, with whatever has been recorded
   * against it.
   *
   * ⚠️ Returns the full list rather than only stored rows. A checklist that shows just what has been
   * ticked cannot show what is outstanding, which is the only question it exists to answer.
   */
  async listDocuments(studentId: string) {
    await this.getOne(studentId); // campus scoping + existence, in the service (§22.8)
    const rows = await this.db.studentDocument.findMany({ where: { studentId } });
    const byType = new Map(rows.map((r) => [r.type, r]));
    return (Object.keys(DOCUMENT_LABELS) as StudentDocumentType[]).map((type) => {
      const row = byType.get(type);
      return {
        type,
        label: DOCUMENT_LABELS[type],
        mandatory: MANDATORY_DOCUMENTS.includes(type),
        received: row?.received ?? false,
        receivedAt: row?.receivedAt ?? null,
        fileKey: row?.fileKey ?? null,
        note: row?.note ?? null,
      };
    });
  }

  /**
   * Record (or clear) one document against a student.
   *
   * ⚠️ find-then-write, NOT `upsert`. The tenant Prisma extension merges `schoolId` into the where
   * clause, which breaks a unique selector — a documented trap in this codebase (CLAUDE.md).
   */
  async setDocument(studentId: string, type: StudentDocumentType, dto: SetStudentDocumentDto) {
    await this.getOne(studentId);
    const existing = await this.db.studentDocument.findFirst({ where: { studentId, type } });
    // Stamped only on the transition into "received": re-saving a note must not rewrite the date on
    // which the school actually took delivery.
    const receivedAt = dto.received ? (existing?.received ? existing.receivedAt : new Date()) : null;
    const data = {
      received: dto.received,
      receivedAt,
      receivedById: dto.received ? (this.ctx.user?.userId ?? null) : null,
      fileKey: dto.fileKey ?? null,
      note: dto.note ?? null,
    };
    const row = existing
      ? await this.db.studentDocument.update({ where: { id: existing.id }, data })
      : await this.db.studentDocument.create({ data: { ...data, schoolId: this.ctx.schoolId!, studentId, type } });
    await this.audit.record({
      action: AuditActions.STUDENT_UPDATED,
      entityType: 'StudentDocument',
      entityId: row.id,
      oldValue: { type, received: existing?.received ?? false },
      newValue: { type, received: row.received },
    });
    return { type, label: DOCUMENT_LABELS[type], mandatory: MANDATORY_DOCUMENTS.includes(type), received: row.received, receivedAt: row.receivedAt, fileKey: row.fileKey, note: row.note };
  }

  static recordGaps(
    s: { religion: string | null; addressLine: string | null; city: string | null;
         emergencyName: string | null; emergencyPhone: string | null },
    guardianCount: number,
  ): string[] {
    const gaps: string[] = [];
    if (guardianCount === 0) gaps.push('Guardian');
    if (!s.religion) gaps.push('Religion');
    if (!s.addressLine) gaps.push('Address');
    if (!s.city) gaps.push('City');
    // One item, not two: half an emergency contact is no emergency contact.
    if (!s.emergencyName || !s.emergencyPhone) gaps.push('Emergency contact');
    return gaps;
  }

  async update(id: string, dto: UpdateStudentDto) {
    const before = await this.getOne(id);
    const updated = await this.db.student.update({
      where: { id },
      data: {
        fullName: dto.fullName,
        gender: dto.gender,
        dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
        /**
         * ⚠️ **The admission-record fields were accepted by the DTO and silently dropped here.**
         * Tier 1 added them to `UpdateStudentDto` without adding them to this write, so a PATCH
         * returned 200 and changed nothing — the worst kind of bug, because the caller is told it
         * worked. Fixed with Tier 2; the integration test now pins every field.
         *
         * `undefined` (key omitted by the caller) leaves the column alone; an explicit value —
         * including an empty string — writes. That distinction is what lets the profile form clear
         * a field without every other field being resent.
         */
        religion: dto.religion,
        addressLine: dto.addressLine,
        city: dto.city,
        emergencyName: dto.emergencyName,
        emergencyPhone: dto.emergencyPhone,
        emergencyRelation: dto.emergencyRelation,
        previousSchool: dto.previousSchool,
        lastClassPassed: dto.lastClassPassed,
        lastResult: dto.lastResult,
        reasonForLeaving: dto.reasonForLeaving,
        slcReceived: dto.slcReceived,
        bloodGroup: dto.bloodGroup,
        medicalNotes: dto.medicalNotes,
        nationality: dto.nationality,
        permanentAddress: dto.permanentAddress,
        /** The student's photograph: the object key from the presigned upload (Tier 3). The column
         *  existed from the start with nothing ever writing to it. */
        photoKey: dto.photoKey,
        /** Parent declaration (Tier 3). Version and acceptor travel together — see the DTO. */
        declarationVersion: dto.declarationVersion,
        declarationAcceptedBy: dto.declarationAcceptedBy,
        declarationAcceptedAt: dto.declarationVersion === undefined ? undefined : new Date(),
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
    // Zero-padded: the GR number is the child's permanent identity (on the leaving certificate, every
    // receipt) — GR-0031, never GR-31 — so it matches how a school actually writes it.
    return `${school.grPrefix}${String(updated.nextGrNumber - 1).padStart(4, '0')}`;
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

  async setGuardianRelation(studentId: string, linkId: string, relation: GuardianRelation): Promise<void> {
    await this.getOne(studentId);
    await this.guardians.setRelation(studentId, linkId, relation);
  }

  async updateGuardianContact(studentId: string, linkId: string, dto: UpdateGuardianContactDto) {
    await this.getOne(studentId);
    return this.guardians.updateContact(studentId, linkId, dto);
  }
}
