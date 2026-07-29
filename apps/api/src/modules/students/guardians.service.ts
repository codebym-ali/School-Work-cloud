import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { GuardianRelation } from '@prisma/client';
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
import type { GuardianResolutionDto } from './dto/student.dto';

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
        cnicEnc: res.cnic ? this.crypto.encrypt(res.cnic) : null,
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
    await this.db.studentGuardian.updateMany({
      where: { studentId, isPrimary: true },
      data: { isPrimary: false },
    });
    await this.db.studentGuardian.update({ where: { id: guardianLinkId }, data: { isPrimary: true } });
    // Who receives fee notices and is contacted first — a meaningful change of responsibility.
    await this.audit.record({
      action: AuditActions.PRIMARY_GUARDIAN_CHANGED,
      entityType: 'Student',
      entityId: studentId,
      newValue: { parentId: link.parentId, guardianLinkId },
    });
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
