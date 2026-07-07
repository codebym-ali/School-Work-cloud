import { Type } from 'class-transformer';
import {
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
  @IsUUID() campusId!: string;
  @IsUUID() classId!: string;
  @IsUUID() feeHeadId!: string;
  @IsUUID() academicYearId!: string;

  @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive()
  amount!: number;

  @IsEnum(FeeFrequency)
  frequency!: FeeFrequency;
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
