import { IsEmail, IsOptional, IsString, Length, Matches, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

export class SwitchChildDto {
  @IsString()
  @MinLength(1)
  studentId!: string;
}

/** @deprecated Legacy student-centric login — replaced by ParentLoginDto. Kept for old STUDENT-role transition. */
export class StudentLoginDto {
  @IsString()
  @MinLength(1)
  registrationNo!: string;

  @IsString()
  @Matches(/^\d{5}-?\d{7}-?\d$/, { message: 'CNIC/B-Form must be 13 digits' })
  cnic!: string;
}

/** Parent portal sign-in: parent's own email + password. */
export class ParentLoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

/** Set password from an invite link (parent portal). */
export class SetPortalPasswordDto {
  @IsString()
  token!: string;

  @IsString()
  @Matches(/^(?=.*[A-Z])(?=.*\d).{8,}$/, { message: 'Password must be at least 8 characters with 1 uppercase letter and 1 digit' })
  password!: string;

  @IsString()
  confirmPassword!: string;
}

/** Forgot password for parent portal. */
export class ParentForgotPasswordDto {
  @IsEmail()
  email!: string;
}

/** Officer sets portal credentials during admission. */
export class CreatePortalCredentialsDto {
  @IsString()
  @Matches(/^(?=.*[A-Z])(?=.*\d).{8,}$/, { message: 'Password must be at least 8 characters with 1 uppercase letter and 1 digit' })
  password!: string;

  @IsString()
  confirmPassword!: string;
}

export class MfaChallengeDto {
  @IsString()
  mfaToken!: string;

  /**
   * A 6-digit TOTP **or** a recovery code (§22.5) — the shape must admit both, or a locked-out
   * user's recovery code is rejected by validation before the service can even try it, which is
   * precisely the lockout recovery codes exist to end. Dashes/spaces/case are tolerated because
   * the code is copied off paper; the service normalises before comparing.
   */
  @IsString()
  @Length(6, 24)
  @Matches(/^[a-z0-9\s-]+$/i, { message: 'code must be a 6-digit code or a recovery code' })
  code!: string;
}

export class MfaVerifyDto {
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;
}

export class DisableMfaDto {
  @IsString()
  password!: string;

  @IsString()
  @Length(6, 6)
  code!: string;
}

export class ChangePasswordDto {
  @IsString()
  currentPassword!: string;

  // Blueprint §22.3: min 10 chars (HIBP check applied in the service).
  @IsString()
  @MinLength(10)
  newPassword!: string;
}

export class ForgotPasswordDto {
  @IsEmail()
  email!: string;
}

/** The owner's display name (Owner UX Phase 2). Empty clears it. */
export class SetMyNameDto {
  @IsString() @Length(0, 120)
  fullName!: string;
}

export class ResetPasswordDto {
  @IsString()
  token!: string;

  @IsString()
  @MinLength(10)
  newPassword!: string;

  @IsOptional()
  @IsString()
  code?: string; // MFA code if the account has MFA enabled
}

/** SA5: set the break-glass session cookie from an enter token. */
export class BreakGlassEnterDto {
  @IsString()
  token!: string;
}
