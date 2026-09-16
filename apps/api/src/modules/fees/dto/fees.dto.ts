import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
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
  ValidateNested,
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

/** Invoice one student for one period (B1). The class, campus and price come from their ACTIVE
 *  enrolment — never from the caller, who must not be trusted to say which class prices a child. */
export class CreateStudentInvoiceDto {
  @IsUUID() studentId!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(12) month!: number;
  @Type(() => Number) @IsInt() @Min(2000) @Max(2100) year!: number;
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

  /**
   * Storage key of the transfer screenshot / stamped challan / cheque image, as returned by
   * `POST /uploads/confirm`. Never a URL — the object is private and is read back only through
   * a short-lived presigned link. The service checks the key belongs to this school.
   */
  @IsOptional() @IsString() @MaxLength(300)
  proofFileKey?: string;
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
  /**
   * One student's payments. ⚠️ Without this the student profile fetched the SCHOOL's latest page of
   * payments and filtered in the browser — so once a school passed a page of payments, a student's
   * older receipts silently disappeared from their own profile.
   */
  @IsOptional() @IsUUID() studentId?: string;
}

export class DefaultersQuery {
  @IsOptional() @IsUUID() campusId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) minDays?: number;
}

// ── Payment claims ───────────────────────────────────────────────────────────
export class SubmitClaimDto {
  @IsUUID() invoiceId!: string;

  @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive()
  amount!: number;

  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @IsOptional() @IsString() @MaxLength(120)
  transactionRef?: string;

  /** The date the payer says they paid — not when they submitted it. */
  @IsDateString()
  paidOn!: string;

  @IsOptional() @IsString() @MaxLength(300)
  proofFileKey?: string;

  @IsOptional() @IsString() @MaxLength(300)
  note?: string;

  /** Office only: the clerk who took the money is the verifier, so no second review. */
  @IsOptional() @IsBoolean()
  autoVerify?: boolean;
}

/**
 * What a guardian submits through the tokenised link.
 *
 * No `invoiceId` — the token carries it. Accepting one from the body would let anyone holding
 * any valid link file claims against every invoice in the school, which is the entire attack
 * this surface has to be closed against. No `autoVerify` either: a guardian's own screenshot
 * confirming itself would defeat the claim/payment split.
 */
export class SubmitLinkClaimDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive()
  amount!: number;

  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @IsOptional() @IsString() @MaxLength(120)
  transactionRef?: string;

  /** The date the payer says they paid — not when they submitted it. */
  @IsDateString()
  paidOn!: string;

  /** The quarantine key just PUT to. Promoted (and virus-scanned) as part of submitting. */
  @IsOptional() @IsString() @MaxLength(300)
  proofFileKey?: string;

  /** Needed to re-check the magic bytes against the declared type on promotion. */
  @IsOptional() @IsString() @MaxLength(100)
  proofMimeType?: string;

  @IsOptional() @IsString() @MaxLength(300)
  note?: string;
}

/**
 * What an aggregator posts when a parent pays inside their bank app (§5.3).
 *
 * Note what is NOT here: any notion of who collected the money. The caller is unauthenticated,
 * so an actor taken from this body would be an actor chosen by a stranger.
 */
export class AggregatorSettlementDto {
  /** The consumer number printed on the challan — carries the tenancy, so no Host is needed. */
  @IsString() @MinLength(4) @MaxLength(20)
  psid!: string;

  @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive()
  amount!: number;

  /** The aggregator's own reference. Doubles as the idempotency key: banks retry. */
  @IsString() @MinLength(4) @MaxLength(120)
  aggregatorRef!: string;
}

export class LinkUploadDto {
  @IsString() @MinLength(1) @MaxLength(200) filename!: string;
  @IsString() @MinLength(1) @MaxLength(100) mimeType!: string;
}

export class RejectClaimDto {
  /** Shown to whoever submitted it, so "no" is actionable rather than mysterious. */
  @IsString() @MinLength(3) @MaxLength(300)
  reason!: string;
}

export class ClaimListQuery extends PaginationQuery {
  @IsOptional() @IsIn(['PENDING', 'VERIFIED', 'REJECTED']) status?: string;
  @IsOptional() @IsUUID() studentId?: string;
}

/**
 * Which column in THIS bank's export holds what.
 *
 * ⚠️ The whole point of the feature working against a bank nobody has seen. HBL, Meezan, UBL and
 * Alfalah each export different headers; hard-coding any one of them would make reconciliation work
 * for exactly one school. `valueDate` and `credit` are required because a statement line without a
 * date or an amount is not a line.
 */
export class StatementColumnMap {
  @IsString() @MaxLength(80) valueDate!: string;
  @IsString() @MaxLength(80) credit!: string;
  @IsOptional() @IsString() @MaxLength(80) narration?: string;
  @IsOptional() @IsString() @MaxLength(80) reference?: string;
  @IsOptional() @IsString() @MaxLength(80) counterparty?: string;
}

export class ImportStatementDto {
  /** The bank, as the school calls it. Also the key the column mapping is remembered against. */
  @IsString() @MinLength(1) @MaxLength(60) bankLabel!: string;

  @IsOptional() @IsString() @MaxLength(200) fileName?: string;

  /** The file itself. Statements are small — a month of one account is measured in kilobytes. */
  @IsString() @MinLength(1) @MaxLength(2_000_000) csv!: string;

  @ValidateNested() @Type(() => StatementColumnMap) columns!: StatementColumnMap;
}
