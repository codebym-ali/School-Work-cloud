import { IsBoolean, IsDateString, IsEmail, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PlanTier, PlatformRole } from '@prisma/client';
import { PaginationQuery } from '@common';

export class ListTenantsQuery extends PaginationQuery {
  /** Free-text match against tenant name or subdomain. */
  @IsOptional() @IsString() @MaxLength(120)
  search?: string;
}

export class PlatformLoginDto {
  @IsEmail()
  email!: string;

  @IsString() @MinLength(1)
  password!: string;
}

export class ProvisionTenantDto {
  @IsString() @MinLength(1) @MaxLength(120)
  name!: string;

  /** DNS label: lowercase alphanumerics with single dashes between segments, no leading/trailing dash. */
  @IsString() @MinLength(2) @MaxLength(40)
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'subdomain must be lowercase letters, digits and single dashes (no leading/trailing dash)',
  })
  subdomain!: string;

  @IsEmail()
  ownerEmail!: string;
  // SA2 (SA-P3): NO password field. The console never accepts a typed password — provisioning
  // returns a one-time onboarding link and the owner sets their own password. A sent `ownerPassword`
  // is rejected (forbidNonWhitelisted → 400), so the "no password in the console" rule is
  // server-enforced (SA-P6), not merely a UI omission.
}

/** Suspending a tenant is destructive (SA-P2) — a non-blank reason is mandatory and audited. */
export class SuspendTenantDto {
  @IsString() @MinLength(1) @MaxLength(500)
  reason!: string;
}

/** Start a break-glass session into a school (SA5) — a non-blank reason is mandatory and audited. */
export class BreakGlassDto {
  @IsString() @MinLength(1) @MaxLength(500)
  reason!: string;
}

/** Schedule a tenant termination (SA7) — a non-blank reason is mandatory and audited. */
export class TerminateDto {
  @IsString() @MinLength(1) @MaxLength(500)
  reason!: string;
}

/** Confirm the IRREVERSIBLE hard-delete (SA7, SA-P5) — the operator retypes the subdomain to proceed. */
export class PurgeDto {
  @IsString() @MinLength(1) @MaxLength(60)
  confirmSubdomain!: string;
}

// ── SA6 vendor billing (D3: in-house, per-student) ───────────────────────────────────────────────
/** Set the vendor's monthly PER-STUDENT price for a school (SA6). 0 is allowed (a free / pilot tenant);
 *  capped generously so a fat-finger can't invoice a fortune. */
export class SetPriceDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  pricePerStudent!: number;
}

/** Generate a vendor invoice for one school for one billing month (SA6). */
export class GenerateInvoiceDto {
  @IsUUID()
  tenantId!: string;

  @IsInt() @Min(2000) @Max(2100)
  year!: number;

  @IsInt() @Min(1) @Max(12)
  month!: number;
}

/** Record an OFFLINE payment against an issued invoice (SA6, D3 — the vendor collects by bank
 *  transfer/cash/cheque and marks it here; no card rails in v1). */
export class RecordPaymentDto {
  @IsIn(['BANK_TRANSFER', 'CASH', 'CHEQUE', 'OTHER'])
  method!: string;

  @IsOptional() @IsString() @MaxLength(120)
  reference?: string;

  @IsOptional() @IsDateString()
  paidAt?: string;
}

/** Void an issued invoice (SA6) — a non-blank reason is recorded and audited. */
export class VoidInvoiceDto {
  @IsString() @MinLength(1) @MaxLength(500)
  reason!: string;
}

/** Toggle a vendor-wide billing setting (SA6c). */
export class BillingSettingsDto {
  @IsBoolean()
  autoReactivateOnPayment!: boolean;
}

/** Filter the vendor invoice list (SA6). */
export class ListInvoicesQuery extends PaginationQuery {
  @IsOptional() @IsUUID()
  tenantId?: string;

  @IsOptional() @IsIn(['ISSUED', 'PAID', 'VOID'])
  status?: string;
}

// ── SA8 leads / demo requests ─────────────────────────────────────────────────────────────────────
/** A demo/contact request from the PUBLIC marketing site (SA8). `website` is a honeypot — real users
 *  leave it blank; a bot that fills it is silently accepted (200) but never saved. */
export class DemoRequestDto {
  @IsString() @MinLength(1) @MaxLength(120)
  name!: string;

  @IsEmail() @MaxLength(200)
  email!: string;

  @IsOptional() @IsString() @MaxLength(160)
  schoolName?: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  @IsOptional() @IsInt() @Min(0) @Max(1_000_000)
  studentCount?: number;

  @IsOptional() @IsString() @MaxLength(2000)
  message?: string;

  @IsOptional() @IsString() @MaxLength(200)
  website?: string; // honeypot — must stay empty
}

/** Filter the console leads inbox (SA8). */
export class ListLeadsQuery extends PaginationQuery {
  @IsOptional() @IsIn(['NEW', 'CONTACTED', 'CONVERTED', 'CLOSED'])
  status?: string;
}

/** Advance a lead through the pipeline and/or add an internal note (SA8). */
export class UpdateLeadDto {
  @IsOptional() @IsIn(['NEW', 'CONTACTED', 'CONVERTED', 'CLOSED'])
  status?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  note?: string;
}

/** Change a tenant's plan tier (SA3). Must be one of the catalog tiers (BASIC / PLUS / PRO). */
export class ChangePlanDto {
  @IsEnum(PlanTier)
  planTier!: PlanTier;
}

/** Change a vendor operator's role and/or status (SA4). Both optional; status is limited to the two
 *  states the console toggles (enable / disable) — INVITED / LOCKED are not set through here. */
export class UpdateOperatorDto {
  @IsOptional() @IsEnum(PlatformRole)
  role?: PlatformRole;

  @IsOptional() @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}

/** Invite a new vendor operator (SA4b). NO password — a one-time onboarding link is returned and the
 *  operator sets their own (SA-P3, server-enforced like provisioning). */
export class CreateOperatorDto {
  @IsEmail()
  email!: string;

  @IsOptional() @IsString() @MaxLength(120)
  name?: string;

  @IsEnum(PlatformRole)
  role!: PlatformRole;
}

/** An INVITED operator sets their own password via the SA4b onboarding token (public, no session). */
export class PlatformSetPasswordDto {
  @IsString()
  token!: string;

  @IsString() @MinLength(10) @MaxLength(200)
  newPassword!: string;
}

/** Step 2 of the platform two-step login: the pending token + a TOTP or recovery code (SA0). */
export class PlatformMfaDto {
  @IsString()
  mfaToken!: string;

  /**
   * A 6-digit TOTP **or** a recovery code — the shape must admit both, or a locked-out operator's
   * recovery code is rejected by validation before the service can try it. Dashes/spaces/case are
   * tolerated (copied off paper); the service normalises before comparing.
   */
  @IsString()
  @Length(6, 24)
  @Matches(/^[a-z0-9\s-]+$/i, { message: 'code must be a 6-digit code or a recovery code' })
  code!: string;
}

/** Confirms platform MFA enrolment with a fresh 6-digit TOTP (SA0). */
export class PlatformMfaEnrollConfirmDto {
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;
}
