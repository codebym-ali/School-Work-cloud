import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma, type GuardianRelation } from '@prisma/client';
import {
  AppError,
  ErrorCodes,
  FIELD_ENCRYPTION,
  FieldEncryption,
  normalizePkPhone,
  AuditActions,
  TenantContext,
} from '@common';
import { AuditService, TenantPrismaService } from '@database';
import type { GuardianResolutionDto, UpdateGuardianContactDto } from './dto/student.dto';

/**
 * Parent-account resolution + student↔guardian links (blueprint §8).
 * On CREATE the server refuses to make a duplicate for an existing phone — it
 * returns 409 with the existing parentId so the client can switch to LINK
 * (never a silent auto-merge).
 */
@Injectable()
export class GuardiansService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    @Inject(FIELD_ENCRYPTION) private readonly crypto: FieldEncryption,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  /** Find existing parents by normalized phone (feeds the admit "link?" UI). */
  async findByPhone(rawPhone: string) {
    const phone = normalizePkPhone(rawPhone);
    if (!phone) return [];
    return this.db.parentProfile.findMany({
      where: { phone },
      select: { id: true, fullName: true, phone: true },
    });
  }

  /** Resolve a guardian to a parentId per the explicit LINK/CREATE choice (§8). */
  async resolveParent(res: GuardianResolutionDto): Promise<string> {
    if (res.mode === 'LINK') {
      const parent = await this.db.parentProfile.findFirst({ where: { id: res.parentId } });
      if (!parent) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Parent not found');
      return parent.id;
    }

    const phone = normalizePkPhone(res.phone ?? '');
    if (!phone) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Invalid phone number');
    }
    const existing = await this.db.parentProfile.findFirst({ where: { phone } });
    if (existing) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        HttpStatus.CONFLICT,
        'A parent with this phone already exists — link instead of creating',
        [{ field: 'parentId', issue: existing.id }],
      );
    }

    // A guardian is a ParentProfile and nothing else — no User row (scope B, 2026-07-29).
    // Parents do not get logins (locked decision in Key Decisions), so minting one per guardian
    // created a login-less INVITED account with a synthetic `p-<uuid>@invite.local` address that
    // nothing could ever use. It also made the guardian's email collide with the staff/admin
    // namespace, so a real address already held by a live account returned a 409 the front desk
    // could not clear. Both the placeholder and that entire failure mode are gone with the row.
    const parent = await this.db.parentProfile.create({
      data: {
        schoolId: this.sid,
        fullName: res.fullName!,
        email: res.email?.toLowerCase() ?? null,
        phone,
        // CREATE only — a LINK must never rewrite an existing parent's record from a form filled
        // in about a different child.
        occupation: res.occupation ?? null,
        cnicEnc: res.cnic ? this.crypto.encrypt(res.cnic, this.sid) : null,
      },
    });
    return parent.id;
  }

  /** Link a parent to a student; enforce exactly one primary per student (§8.3). */
  async link(
    studentId: string,
    parentId: string,
    relation: GuardianRelation,
    isPrimary: boolean,
  ): Promise<void> {
    const dup = await this.db.studentGuardian.findFirst({ where: { studentId, parentId } });
    if (dup) throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Guardian already linked');

    // ⚠️ A student's FIRST guardian is primary whatever the caller asked. Every fee receipt and every
    // SMS resolves the primary guardian; a student whose only guardian is not primary is contacted by
    // nobody, silently, while the profile shows a guardian on record.
    if (!isPrimary && (await this.db.studentGuardian.count({ where: { studentId } })) === 0) isPrimary = true;

    if (isPrimary) {
      await this.db.studentGuardian.updateMany({
        where: { studentId, isPrimary: true },
        data: { isPrimary: false },
      });
    }
    await this.db.studentGuardian.create({
      data: { schoolId: this.sid, studentId, parentId, relation, isPrimary },
    });
    await this.audit.record({
      action: AuditActions.GUARDIAN_LINKED,
      entityType: 'Student',
      entityId: studentId,
      newValue: { parentId, relation, isPrimary },
    });
  }

  async setPrimary(studentId: string, guardianLinkId: string): Promise<void> {
    const link = await this.db.studentGuardian.findFirst({ where: { id: guardianLinkId, studentId } });
    if (!link) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Guardian link not found');
    if (link.isPrimary) return; // already primary: nothing to change, nothing to audit
    try {
      await this.db.studentGuardian.updateMany({
        where: { studentId, isPrimary: true },
        data: { isPrimary: false },
      });
      await this.db.studentGuardian.update({ where: { id: guardianLinkId }, data: { isPrimary: true } });
    } catch (e) {
      // ⚠️ The partial UNIQUE index `student_guardians_one_primary_per_student` guarantees exactly one
      // primary even when two people change it at once: the database refuses the second. That refusal
      // arrives as a raw P2002; answer it as the conflict it is, not a 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'The primary guardian was changed at the same time. Reload and try again.');
      }
      throw e;
    }
    // Who receives fee notices and is contacted first — a meaningful change of responsibility.
    await this.audit.record({
      action: AuditActions.PRIMARY_GUARDIAN_CHANGED,
      entityType: 'Student',
      entityId: studentId,
      newValue: { parentId: link.parentId, guardianLinkId },
    });
  }

  /**
   * Change how this guardian relates to the student.
   *
   * ⚠️ `PATCH /students/:id/guardians/:guardianId` accepted `relation` in its DTO and IGNORED it,
   * returning 204 with nothing changed. This is what it now calls.
   */
  async setRelation(studentId: string, guardianLinkId: string, relation: GuardianRelation): Promise<void> {
    const link = await this.db.studentGuardian.findFirst({ where: { id: guardianLinkId, studentId } });
    if (!link) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Guardian link not found');
    if (link.relation === relation) return;
    await this.db.studentGuardian.update({ where: { id: guardianLinkId }, data: { relation } });
    await this.audit.record({
      action: AuditActions.GUARDIAN_RELATION_CHANGED,
      entityType: 'Student',
      entityId: studentId,
      oldValue: { guardianLinkId, relation: link.relation },
      newValue: { guardianLinkId, relation },
    });
  }

  /**
   * Correct a guardian's own record. Edits the PARENT, so it applies to every child they are guardian
   * of; the response says how many, so the screen can say so.
   *
   * ⚠️ **A changed phone is UNVERIFIED again, and that stops SMS to it.** Verification proves a person
   * controls a NUMBER; it does not carry to a different number. Every SMS dispatcher skips an unverified
   * phone, so a corrected number receives nothing until verified. The caller must be told, not left to
   * discover it when an absence notice never arrives.
   *
   * ⚠️ **A number already held by another guardian is refused**, exactly as on CREATE. One number, one
   * guardian record: two records sharing a phone would each be texted, and a household would get every
   * message twice. The 409 names the existing record so the office can link it instead.
   */
  async updateContact(
    studentId: string,
    guardianLinkId: string,
    dto: UpdateGuardianContactDto,
  ): Promise<{ phoneChanged: boolean; phoneVerified: boolean; childCount: number }> {
    const link = await this.db.studentGuardian.findFirst({
      where: { id: guardianLinkId, studentId },
      include: { parent: true },
    });
    if (!link) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Guardian link not found');
    const parent = link.parent;

    const data: Prisma.ParentProfileUpdateInput = {};
    if (dto.fullName !== undefined) data.fullName = dto.fullName.trim();
    if (dto.email !== undefined) data.email = dto.email.trim() === '' ? null : dto.email.trim().toLowerCase();
    if (dto.occupation !== undefined) data.occupation = dto.occupation.trim() === '' ? null : dto.occupation.trim();

    let phoneChanged = false;
    if (dto.phone !== undefined) {
      const phone = normalizePkPhone(dto.phone);
      if (!phone) throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Invalid phone number');
      if (phone !== parent.phone) {
        const clash = await this.db.parentProfile.findFirst({
          where: { phone, id: { not: parent.id } },
          select: { id: true, fullName: true },
        });
        if (clash) {
          throw new AppError(
            ErrorCodes.CONFLICT,
            HttpStatus.CONFLICT,
            `${clash.fullName} is already on record with this number. Link them as a guardian instead.`,
            [{ field: 'parentId', issue: clash.id }],
          );
        }
        phoneChanged = true;
        data.phone = phone;
        data.phoneVerifiedAt = null;
        data.otpCodeHash = null;
        data.otpExpiresAt = null;
        data.otpAttempts = 0;
      }
    }

    if (Object.keys(data).length > 0) {
      await this.db.parentProfile.update({ where: { id: parent.id }, data });
      await this.audit.record({
        action: AuditActions.GUARDIAN_CONTACT_UPDATED,
        entityType: 'ParentProfile',
        entityId: parent.id,
        oldValue: { fullName: parent.fullName, phone: parent.phone, email: parent.email, occupation: parent.occupation },
        newValue: { fullName: data.fullName, phone: data.phone, email: data.email, occupation: data.occupation, phoneReverified: phoneChanged },
      });
    }

    const childCount = await this.db.studentGuardian.count({ where: { parentId: parent.id } });
    return { phoneChanged, phoneVerified: !phoneChanged && parent.phoneVerifiedAt !== null, childCount };
  }

  async remove(studentId: string, guardianLinkId: string): Promise<void> {
    const link = await this.db.studentGuardian.findFirst({ where: { id: guardianLinkId, studentId } });
    if (!link) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Guardian link not found');
    if (link.isPrimary) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Set another guardian primary before removing this one');
    }
    await this.db.studentGuardian.delete({ where: { id: guardianLinkId } });

    // The link row is gone, so record who the guardian WAS — the id alone would dangle.
    const parent = await this.db.parentProfile.findFirst({ where: { id: link.parentId }, select: { fullName: true, phone: true } });
    await this.audit.record({
      action: AuditActions.GUARDIAN_UNLINKED,
      entityType: 'Student',
      entityId: studentId,
      oldValue: { parentId: link.parentId, name: parent?.fullName, phone: parent?.phone, relation: link.relation },
    });
  }
}
