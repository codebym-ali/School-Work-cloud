import { HttpStatus, Injectable } from '@nestjs/common';
import { AppError, AuditActions, ErrorCodes, TenantContext } from '@common';
import { AuditService, TenantPrismaService } from '@database';
import type {
  CreateDiscountDto,
  CreateFeeHeadDto,
  CreateFeeStructureDto,
  UpsertLateFeePolicyDto,
} from './dto/fees.dto';

/** Fee configuration (blueprint §12): fee heads, structures, late-fee policy, discounts. */
@Injectable()
export class FeeSetupService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }
  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  // ── Fee heads ────────────────────────────────────────────────────────────────
  createHead(dto: CreateFeeHeadDto) {
    return this.db.feeHead.create({ data: { schoolId: this.sid, name: dto.name } });
  }
  listHeads() {
    return this.db.feeHead.findMany({ orderBy: { name: 'asc' } });
  }

  // ── Fee structures ───────────────────────────────────────────────────────────
  createStructure(dto: CreateFeeStructureDto) {
    return this.db.feeStructure.create({
      data: {
        schoolId: this.sid,
        campusId: dto.campusId,
        classId: dto.classId,
        feeHeadId: dto.feeHeadId,
        academicYearId: dto.academicYearId,
        amount: dto.amount,
        frequency: dto.frequency,
      },
    });
  }
  listStructures(classId?: string) {
    return this.db.feeStructure.findMany({
      where: { isActive: true, ...(classId ? { classId } : {}) },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ── Late-fee policy (one per school) ─────────────────────────────────────────
  async upsertLateFeePolicy(dto: UpsertLateFeePolicyDto) {
    const existing = await this.db.lateFeePolicy.findFirst({ where: { schoolId: this.sid } });
    const data = { graceDays: dto.graceDays, mode: dto.mode, amount: dto.amount, maxAmount: dto.maxAmount };
    if (existing) return this.db.lateFeePolicy.update({ where: { id: existing.id }, data });
    return this.db.lateFeePolicy.create({ data: { schoolId: this.sid, ...data } });
  }
  getLateFeePolicy() {
    return this.db.lateFeePolicy.findFirst({ where: { schoolId: this.sid } });
  }

  // ── Discounts ────────────────────────────────────────────────────────────────
  async createDiscount(dto: CreateDiscountDto) {
    if (dto.type === 'PERCENT' && dto.value > 100) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Percent discount cannot exceed 100');
    }
    const discount = await this.db.discount.create({
      data: {
        schoolId: this.sid,
        studentId: dto.studentId,
        type: dto.type,
        value: dto.value,
        feeHeadId: dto.feeHeadId,
        reason: dto.reason,
        status: 'ACTIVE',
        validFrom: dto.validFrom ?? new Date(),
        approvedById: this.ctx.user!.userId,
      },
    });
    await this.audit.record({
      action: AuditActions.DISCOUNT_APPROVED,
      entityType: 'Discount',
      entityId: discount.id,
      newValue: { studentId: dto.studentId, type: dto.type, value: dto.value },
    });
    return discount;
  }

  async revokeDiscount(id: string) {
    const discount = await this.db.discount.findFirst({ where: { id } });
    if (!discount) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Discount not found');
    const updated = await this.db.discount.update({ where: { id }, data: { status: 'REVOKED' } });
    await this.audit.record({ action: AuditActions.DISCOUNT_REVOKED, entityType: 'Discount', entityId: id });
    return updated;
  }

  listDiscounts(studentId?: string) {
    return this.db.discount.findMany({
      where: studentId ? { studentId } : {},
      orderBy: { createdAt: 'desc' },
    });
  }
}
