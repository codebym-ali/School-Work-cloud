import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppError, assertCampusAccess, AuditActions, ErrorCodes, TenantContext } from '@common';
import { AuditService, TenantPrismaService } from '@database';
import type {
  CopyFeePlanDto,
  CreateDiscountDto,
  CreateFeeHeadDto,
  CreateFeeStructureDto,
  UpdateFeeStructureDto,
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
  async createHead(dto: CreateFeeHeadDto) {
    try {
      return await this.db.feeHead.create({ data: { schoolId: this.sid, name: dto.name } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, `You already have a fee called “${dto.name}”.`);
      }
      throw e;
    }
  }

  listHeads() {
    return this.db.feeHead.findMany({ orderBy: { name: 'asc' } });
  }

  /** Rename a fee. The name appears on every invoice line, so a typo is worth correcting. */
  async updateHead(id: string, dto: CreateFeeHeadDto) {
    await this.headOr404(id);
    try {
      return await this.db.feeHead.update({ where: { id }, data: { name: dto.name } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, `You already have a fee called “${dto.name}”.`);
      }
      throw e;
    }
  }

  /**
   * Remove a fee from the school's list.
   *
   * Fee heads were create-and-read only, so the dropdown accumulated everything ever typed —
   * including test debris — with no way for a school to tidy it. Deleting is refused while
   * anything references the head, and the message names what: a head that priced a class or
   * appeared on an invoice must keep existing, or those records stop being explicable.
   */
  async deleteHead(id: string) {
    const head = await this.headOr404(id);
    const [structures, discounts, invoiceItems] = await Promise.all([
      this.db.feeStructure.count({ where: { feeHeadId: id } }),
      this.db.discount.count({ where: { feeHeadId: id } }),
      this.db.feeInvoiceItem.count({ where: { feeHeadId: id } }),
    ]);
    const blockers = [
      structures && `${structures} class price${structures === 1 ? '' : 's'}`,
      invoiceItems && `${invoiceItems} invoice line${invoiceItems === 1 ? '' : 's'}`,
      discounts && `${discounts} discount${discounts === 1 ? '' : 's'}`,
    ].filter(Boolean);
    if (blockers.length) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        HttpStatus.CONFLICT,
        `“${head.name}” is still used by ${blockers.join(' and ')} — it cannot be deleted.`,
      );
    }
    await this.db.feeHead.delete({ where: { id } });
    await this.audit.record({
      action: AuditActions.FEE_HEAD_DELETED,
      entityType: 'FeeHead',
      entityId: id,
      oldValue: { name: head.name },
    });
  }

  private async headOr404(id: string) {
    const head = await this.db.feeHead.findFirst({ where: { id } });
    if (!head) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Fee not found');
    return head;
  }

  // ── Fee structures ───────────────────────────────────────────────────────────
  /**
   * Price one head for one class, from a given month.
   *
   * A second row for the same head with a later `effectiveFrom` is a **revision**, not a
   * duplicate: the earlier price stays so invoices already issued keep the figure they were
   * computed from. Invoicing takes whichever row is in force for the month being billed.
   */
  async createStructure(dto: CreateFeeStructureDto) {
    // Campus comes from the class, which already determines it. Trusting the client's value
    // let a structure point at a campus its class does not belong to.
    const klass = await this.db.class.findFirst({ where: { id: dto.classId }, select: { campusId: true } });
    if (!klass) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Class not found');
    assertCampusAccess(this.ctx.user, klass.campusId);
    this.assertBillableFrequency(dto.frequency);

    const effectiveFrom = await this.resolveEffectiveFrom(dto.academicYearId, dto.effectiveFrom);
    try {
      return await this.db.feeStructure.create({
        data: {
          schoolId: this.sid,
          campusId: klass.campusId,
          classId: dto.classId,
          feeHeadId: dto.feeHeadId,
          academicYearId: dto.academicYearId,
          amount: dto.amount,
          frequency: dto.frequency,
          effectiveFrom,
        },
      });
    } catch (e) {
      // The unique index is the only thing stopping a second identical row, and an unmapped
      // P2002 surfaces as "Internal server error" for what is an ordinary "already priced".
      throw this.asDuplicate(e, effectiveFrom);
    }
  }

  /**
   * Change an existing price, or stop charging it.
   *
   * **The amount is editable only while nothing has been billed from this row.** Once an
   * invoice exists for a month this price covered, editing it would restate what a family was
   * already charged; the honest change is a revision starting from a later month, which
   * `createStructure` records. `isActive` is always toggleable because it only affects future
   * invoice runs — it never touches an issued invoice.
   */
  async updateStructure(id: string, dto: UpdateFeeStructureDto) {
    const existing = await this.structureOr404(id);
    const changingAmount = dto.amount != null && Number(dto.amount) !== Number(existing.amount);

    if (changingAmount) {
      const billed = await this.billedMonths(existing);
      if (billed > 0) {
        throw new AppError(
          ErrorCodes.CONFLICT,
          HttpStatus.CONFLICT,
          `This price has already been billed in ${billed} invoice batch${billed === 1 ? '' : 'es'}. `
          + 'Add a revision starting from a later month instead — changing it here would restate what families were already charged.',
        );
      }
    }

    const updated = await this.db.feeStructure.update({
      where: { id },
      data: { ...(dto.amount != null ? { amount: dto.amount } : {}), ...(dto.isActive != null ? { isActive: dto.isActive } : {}) },
    });
    await this.audit.record({
      action: AuditActions.FEE_STRUCTURE_UPDATED,
      entityType: 'FeeStructure',
      entityId: id,
      oldValue: { amount: Number(existing.amount), isActive: existing.isActive },
      newValue: { amount: Number(updated.amount), isActive: updated.isActive },
    });
    return updated;
  }

  /** Remove a price that was never used. Anything billed is deactivated, never deleted. */
  async deleteStructure(id: string) {
    const existing = await this.structureOr404(id);
    const billed = await this.billedMonths(existing);
    if (billed > 0) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        HttpStatus.CONFLICT,
        'This price has already been billed — switch it off instead of deleting it, so the invoices it produced still make sense.',
      );
    }
    await this.db.feeStructure.delete({ where: { id } });
    await this.audit.record({
      action: AuditActions.FEE_STRUCTURE_DELETED,
      entityType: 'FeeStructure',
      entityId: id,
      oldValue: { amount: Number(existing.amount), frequency: existing.frequency, classId: existing.classId },
    });
  }

  /** `isActive: false` rows are included — the plan screen must show what was switched off. */
  listStructures(classId?: string) {
    return this.db.feeStructure.findMany({
      where: { ...(classId ? { classId } : {}) },
      orderBy: [{ effectiveFrom: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Copy a fee plan — one class's prices into other classes, or a whole year's into the next.
   *
   * This is the job that made fee setup unusable: ten classes and four heads is forty separate
   * forms, and every school re-prices annually. Copying with an optional across-the-board rise
   * turns that into one action.
   *
   * **Skips rather than overwrites.** A target that already has a price for the same head,
   * frequency and start month is left alone and reported — a copy must never silently restate
   * a price somebody set deliberately. Re-running is therefore safe.
   */
  async copyPlan(dto: CopyFeePlanDto) {
    const source = await this.db.feeStructure.findMany({
      where: { classId: dto.fromClassId, academicYearId: dto.fromAcademicYearId, isActive: true },
      orderBy: { effectiveFrom: 'asc' },
    });
    if (!source.length) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'That class has no fee plan to copy.');
    }
    // Only the price currently in force per head — copying a class's whole history into next
    // year would recreate revisions that never happened there.
    const latest = new Map<string, (typeof source)[number]>();
    for (const s of source) latest.set(`${s.feeHeadId}:${s.frequency}`, s);

    const targetYearId = dto.toAcademicYearId ?? dto.fromAcademicYearId;
    const effectiveFrom = await this.resolveEffectiveFrom(targetYearId, dto.effectiveFrom);
    const factor = 1 + (dto.raisePercent ?? 0) / 100;

    let created = 0;
    const skipped: string[] = [];
    for (const classId of dto.toClassIds) {
      const klass = await this.db.class.findFirst({ where: { id: classId }, select: { campusId: true, name: true } });
      if (!klass) {
        skipped.push('unknown class');
        continue;
      }
      assertCampusAccess(this.ctx.user, klass.campusId);

      for (const s of latest.values()) {
        const clash = await this.db.feeStructure.findFirst({
          where: { classId, academicYearId: targetYearId, feeHeadId: s.feeHeadId, frequency: s.frequency, effectiveFrom },
          select: { id: true },
        });
        if (clash) {
          skipped.push(`${klass.name}: already priced`);
          continue;
        }
        await this.db.feeStructure.create({
          data: {
            schoolId: this.sid,
            campusId: klass.campusId,
            classId,
            feeHeadId: s.feeHeadId,
            academicYearId: targetYearId,
            // Round to whole rupees: a 10% rise on 3,333 is a fee a parent has to pay, not a
            // spreadsheet cell, and 3,666.30 on a bill helps nobody.
            amount: Math.round(Number(s.amount) * factor),
            frequency: s.frequency,
            effectiveFrom,
          },
        });
        created++;
      }
    }
    await this.audit.record({
      action: AuditActions.FEE_PLAN_COPIED,
      entityType: 'Class',
      entityId: dto.fromClassId,
      newValue: {
        toClassIds: dto.toClassIds, toAcademicYearId: targetYearId,
        raisePercent: dto.raisePercent ?? 0, created, skipped: skipped.length,
      },
    });
    return { created, skipped: skipped.length, details: skipped };
  }

  // ── helpers ──────────────────────────────────────────────────────────────────
  private async structureOr404(id: string) {
    const row = await this.db.feeStructure.findFirst({ where: { id }, include: { class: { select: { campusId: true } } } });
    if (!row) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Fee structure not found');
    assertCampusAccess(this.ctx.user, row.class.campusId);
    return row;
  }

  /**
   * How many invoice batches this price could have produced — i.e. batches for its class in a
   * month at or after it took effect. Deliberately coarse: it answers "is this row still
   * safely editable?", and erring towards "no" protects a family's bill.
   */
  private async billedMonths(s: { classId: string; academicYearId: string; effectiveFrom: Date }): Promise<number> {
    const from = s.effectiveFrom;
    const batches = await this.db.feeInvoiceBatch.findMany({
      where: { classId: s.classId, academicYearId: s.academicYearId },
      select: { month: true, year: true },
    });
    return batches.filter((b) => Date.UTC(b.year, b.month - 1, 1) >= Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)).length;
  }

  /** Default a new price to the academic year's first day — "this is the fee for the year". */
  private async resolveEffectiveFrom(academicYearId: string, supplied?: string): Promise<Date> {
    if (supplied) return new Date(supplied);
    const year = await this.db.academicYear.findFirst({ where: { id: academicYearId }, select: { startDate: true } });
    if (!year) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Academic year not found');
    return year.startDate;
  }

  /**
   * `ONE_TIME` and `ADMISSION` are in the enum but invoicing never applies them — it bills
   * MONTHLY always and ANNUAL in the year's first month. Accepting one would store a price
   * that looks configured and charges nothing, for ever. Refused with the reason until the
   * behaviour exists (see [[Fees Gaps Register]] F3).
   */
  private assertBillableFrequency(frequency: string): void {
    if (frequency === 'MONTHLY' || frequency === 'ANNUAL') return;
    throw new AppError(
      ErrorCodes.VALIDATION_FAILED,
      HttpStatus.UNPROCESSABLE_ENTITY,
      `Invoicing does not yet charge ${frequency} fees, so this would never appear on a bill. Use MONTHLY or ANNUAL.`,
    );
  }

  private asDuplicate(e: unknown, effectiveFrom: Date): unknown {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return new AppError(
        ErrorCodes.CONFLICT,
        HttpStatus.CONFLICT,
        `This class already has a price for that fee from ${effectiveFrom.toISOString().slice(0, 10)}. Edit it, or start a revision from a different month.`,
      );
    }
    return e;
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
