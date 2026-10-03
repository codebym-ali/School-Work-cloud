import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { Prisma, type GuardianRelation } from '@prisma/client';
import {
  AppError,
  ErrorCodes,
  FIELD_ENCRYPTION,
  FieldEncryption,
  normalizePkPhone,
  normalizePkName,
  normalizeCnic,
  AuditActions,
  TenantContext,
  ENV,
  type Env,
} from '@common';
import { AuditService, TenantPrismaService } from '@database';
import type { GuardianResolutionDto, ParentMatchQuery, UpdateGuardianContactDto } from './dto/student.dto';

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
    @Inject(ENV) private readonly env: Env,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  private hashCnic(cnic: string): string {
    const normalized = normalizeCnic(cnic);
    return createHmac('sha256', this.env.ENCRYPTION_MASTER_KEY).update(normalized ?? cnic).digest('hex');
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

  /**
   * Tiered parent matching for sibling detection during admission.
   * FATHER/MOTHER: CNIC hash (definitive). GUARDIAN: phone (possible).
   */
  async matchParent(q: ParentMatchQuery) {
    const select = {
      id: true, fullName: true, phone: true, fatherName: true,
      dateOfBirth: true, fullNameNorm: true,
      guardianLinks: {
        select: { student: { select: { id: true, fullName: true } } },
      },
    } as const;

    // Tier 1: CNIC hash match (Father / Mother)
    if (q.cnic && (q.relation === 'FATHER' || q.relation === 'MOTHER')) {
      const hash = this.hashCnic(q.cnic);
      const match = await this.db.parentProfile.findFirst({
        where: { cnicHash: hash },
        select,
      });
      if (match) {
        return {
          matches: [this.toMatchResult(match, 'definitive')],
          matchedBy: 'cnic' as const,
        };
      }
    }

    // Tier 2: Phone match (Guardian, or fallback for Father/Mother with no CNIC match)
    if (q.phone) {
      const phone = normalizePkPhone(q.phone);
      if (phone) {
        const byPhone = await this.db.parentProfile.findMany({
          where: { phone },
          select,
        });
        if (byPhone.length > 0) {
          return {
            matches: byPhone.map((p) => this.toMatchResult(p, 'possible')),
            matchedBy: 'phone' as const,
          };
        }
      }
    }

    return { matches: [], matchedBy: null };
  }

  private toMatchResult(
    p: { id: string; fullName: string; phone: string; fatherName: string | null; dateOfBirth: Date | null; guardianLinks: Array<{ student: { id: string; fullName: string } }> },
    confidence: 'definitive' | 'possible',
  ) {
    return {
      id: p.id,
      fullName: p.fullName,
      phone: p.phone.replace(/(\d{4})\d{3}(\d{4})/, '$1-xxx-$2'),
      fatherName: p.fatherName,
      dateOfBirth: p.dateOfBirth,
      childCount: p.guardianLinks.length,
      children: p.guardianLinks.map((l) => ({ id: l.student.id, fullName: l.student.fullName })),
      confidence,
    };
  }

  /** Resolve a guardian to a parentId per the explicit LINK/CREATE choice (§8). */
  async resolveParent(res: GuardianResolutionDto): Promise<string> {
    if (res.mode === 'LINK') {
      const parent = await this.db.parentProfile.findFirst({
        where: { id: res.parentId },
        select: { id: true, cnicHash: true, cnicEnc: true, fatherName: true, fatherNameNorm: true, dateOfBirth: true, fullNameNorm: true },
      });
      if (!parent) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Parent not found');
      await this.progressiveFill(parent, res);
      return parent.id;
    }

    const phone = normalizePkPhone(res.phone ?? '');
    if (!phone) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Invalid phone number');
    }
    const cnicHash = res.cnic ? this.hashCnic(res.cnic) : null;
    if (cnicHash) {
      const byCnic = await this.db.parentProfile.findFirst({
        where: { cnicHash },
        select: { id: true, fullName: true },
      });
      if (byCnic) {
        throw new AppError(
          ErrorCodes.CONFLICT,
          HttpStatus.CONFLICT,
          `A parent with this CNIC already exists (${byCnic.fullName}) — link instead of creating`,
          [{ field: 'parentId', issue: byCnic.id }],
        );
      }
    }

    const existing = await this.db.parentProfile.findFirst({
      where: { phone },
      select: { id: true, fullName: true },
    });
    if (existing && !(res as any).phoneConflictAck) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        HttpStatus.CONFLICT,
        `A parent with this phone already exists (${existing.fullName}). Link them, or re-submit with phoneConflictAck to create anyway.`,
        [{ field: 'parentId', issue: existing.id }],
      );
    }

    const parent = await this.db.parentProfile.create({
      data: {
        schoolId: this.sid,
        fullName: res.fullName!,
        fullNameNorm: normalizePkName(res.fullName!),
        email: res.email?.toLowerCase() ?? null,
        phone,
        occupation: res.occupation ?? null,
        cnicEnc: res.cnic ? this.crypto.encrypt(res.cnic, this.sid) : null,
        cnicHash,
        fatherName: res.fatherName ?? null,
        fatherNameNorm: res.fatherName ? normalizePkName(res.fatherName) : null,
        dateOfBirth: res.dateOfBirth ? new Date(res.dateOfBirth) : null,
      },
    });
    return parent.id;
  }

  /**
   * Fill NULL fields on an existing parent from new form data (LINK mode only).
   * Never overwrites a non-null value — the first admission's data wins.
   */
  private async progressiveFill(
    parent: { id: string; cnicHash: string | null; cnicEnc: string | null; fatherName: string | null; fatherNameNorm: string | null; dateOfBirth: Date | null; fullNameNorm: string | null },
    res: GuardianResolutionDto,
  ): Promise<void> {
    const data: Prisma.ParentProfileUpdateInput = {};
    const filled: string[] = [];

    if (!parent.cnicHash && res.cnic) {
      data.cnicHash = this.hashCnic(res.cnic);
      data.cnicEnc = this.crypto.encrypt(res.cnic, this.sid);
      filled.push('cnic');
    }
    if (!parent.fatherName && res.fatherName) {
      data.fatherName = res.fatherName;
      data.fatherNameNorm = normalizePkName(res.fatherName);
      filled.push('fatherName');
    }
    if (!parent.dateOfBirth && res.dateOfBirth) {
      data.dateOfBirth = new Date(res.dateOfBirth);
      filled.push('dateOfBirth');
    }
    if (!parent.fullNameNorm && res.fullName) {
      data.fullNameNorm = normalizePkName(res.fullName);
      filled.push('fullNameNorm');
    }

    if (filled.length > 0) {
      await this.db.parentProfile.update({ where: { id: parent.id }, data });
      await this.audit.record({
        action: AuditActions.GUARDIAN_PROGRESSIVE_FILL,
        entityType: 'ParentProfile',
        entityId: parent.id,
        newValue: { filledFields: filled },
      });
    }
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
    if (dto.fullName !== undefined) {
      data.fullName = dto.fullName.trim();
      data.fullNameNorm = normalizePkName(dto.fullName.trim());
    }
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
