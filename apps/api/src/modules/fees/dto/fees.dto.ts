import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { DiscountType, FeeFrequency, PaymentMethod } from '@prisma/client';
import { PaginationQuery } from '@common';

// ── Setup ────────────────────────────────────────────────────────────────────
export class CreateFeeHeadDto {
  @IsString() @MinLength(1) @MaxLength(80)
  name!: string;
}

export class CreateFeeStructureDto {
  /** Optional: derived from the class, which already determines the campus. */
  @IsOptional() @IsUUID() campusId?: string;
  @IsUUID() classId!: string;
  @IsUUID() feeHeadId!: string;
  @IsUUID() academicYearId!: string;

  @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive()
  amount!: number;

  @IsEnum(FeeFrequency)
  frequency!: FeeFrequency;

  /**
   * The month this price starts applying from. Omitted ⇒ the academic year's first day, which
   * is what "this is the fee" means when a school sets one up. Supply a later date to record a
   * revision: the earlier row stays, so invoices already issued keep the price they were
   * computed from.
   */
  @IsOptional() @IsDateString()
  effectiveFrom?: string;
}

export class UpdateFeeStructureDto {
  /** Editable only while nothing has been billed from this row — see the service. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive()
  amount?: number;

  /** Stop (or resume) charging it. Only ever affects future invoice runs. */
  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

/** Copy a whole fee plan: one class's into others, or a year's into the next. */
export class CopyFeePlanDto {
  @IsUUID() fromClassId!: string;
  @IsUUID() fromAcademicYearId!: string;

  @IsArray() @ArrayMinSize(1) @IsUUID('4', { each: true })
  toClassIds!: string[];

  /** Omitted ⇒ the same year (copying across classes). */
  @IsOptional() @IsUUID()
  toAcademicYearId?: string;

  /** Across-the-board rise, e.g. 10 for +10%. Rounded to 2dp. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(-100) @Max(500)
  raisePercent?: number;

  /** Where the copied prices start. Omitted ⇒ the target year's first day. */
  @IsOptional() @IsDateString()
  effectiveFrom?: string;
}

export class UpsertLateFeePolicyDto {
  @IsInt() @Min(0) @Max(60)
  graceDays!: number;

  @IsEnum({ FLAT: 'FLAT', PER_DAY: 'PER_DAY' })
  mode!: 'FLAT' | 'PER_DAY';

  @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive()
  amount!: number;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive()
  maxAmount?: number;
}

export class CreateDiscountDto {
  @IsUUID() studentId!: string;

  @IsEnum(DiscountType)
  type!: DiscountType;

  @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive()
  value!: number; // percent 0–100 or fixed amount

  @IsOptional() @IsUUID()
  feeHeadId?: string; // null = all heads

  @IsString() @MinLength(1) @MaxLength(300)
  reason!: string;

  @Type(() => Date) @IsOptional()
  validFrom?: Date;
}

// ── Invoicing ────────────────────────────────────────────────────────────────
export class CreateInvoiceBatchDto {
  @IsUUID() classId!: string;
  @IsInt() @Min(1) @Max(12) month!: number;
  @IsInt() @Min(2000) @Max(3000) year!: number;
}

export class InvoiceListQuery extends PaginationQuery {
  @IsOptional() @IsUUID() studentId?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @Type(() => Number) @IsInt() month?: number;
  @IsOptional() @Type(() => Number) @IsInt() year?: number;
  @IsOptional() @IsUUID() campusId?: string;
}

export class ReasonDto {
  @IsString() @MinLength(1) @MaxLength(500)
  reason!: string;
}

// ── Payments / advances ──────────────────────────────────────────────────────
export class PayInvoiceDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive()
  amountPaid!: number;

  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @IsOptional() @IsString() @MaxLength(120)
  transactionRef?: string;
}

export class CreateAdvanceDto {
  @IsUUID() parentId!: string;

  @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive()
  amount!: number;

  @IsOptional() @IsString() @MaxLength(120)
  transactionRef?: string;
}

export class PaymentListQuery extends PaginationQuery {
  @IsOptional() @Type(() => Date) from?: Date;
  @IsOptional() @Type(() => Date) to?: Date;
  @IsOptional() @IsEnum(PaymentMethod) method?: PaymentMethod;
  @IsOptional() @IsUUID() collectedById?: string;
}

export class DefaultersQuery {
  @IsOptional() @IsUUID() campusId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) minDays?: number;
}
