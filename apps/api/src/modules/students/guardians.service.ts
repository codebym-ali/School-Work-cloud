import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { GuardianRelation } from '@prisma/client';
import {
  AppError,
  ErrorCodes,
  FIELD_ENCRYPTION,
  FieldEncryption,
  normalizePkPhone,
  TenantContext,
} from '@common';
import { TenantPrismaService } from '@database';
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

    // New parent: User(roles=[PARENT], INVITED, no password) + ParentProfile.
    // Email is required+unique; synthesize a placeholder when none is given
    // (parents are invited by SMS; login-by-phone is a later refinement).
    const email = (res.email ?? `p-${randomUUID().slice(0, 12)}@invite.local`).toLowerCase();
    const user = await this.db.user.create({
      data: { schoolId: this.sid, email, roles: ['PARENT'], status: 'INVITED' },
    });
    const parent = await this.db.parentProfile.create({
      data: {
        schoolId: this.sid,
        userId: user.id,
        fullName: res.fullName!,
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
  }

  async setPrimary(studentId: string, guardianLinkId: string): Promise<void> {
    const link = await this.db.studentGuardian.findFirst({ where: { id: guardianLinkId, studentId } });
    if (!link) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Guardian link not found');
    await this.db.studentGuardian.updateMany({
      where: { studentId, isPrimary: true },
      data: { isPrimary: false },
    });
    await this.db.studentGuardian.update({ where: { id: guardianLinkId }, data: { isPrimary: true } });
  }

  async remove(studentId: string, guardianLinkId: string): Promise<void> {
    const link = await this.db.studentGuardian.findFirst({ where: { id: guardianLinkId, studentId } });
    if (!link) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Guardian link not found');
    if (link.isPrimary) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Set another guardian primary before removing this one');
    }
    await this.db.studentGuardian.delete({ where: { id: guardianLinkId } });
  }
}
