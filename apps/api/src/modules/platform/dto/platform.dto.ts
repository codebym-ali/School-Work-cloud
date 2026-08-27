import { IsEmail, IsEnum, IsIn, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';
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
