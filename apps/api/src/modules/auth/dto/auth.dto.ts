import { IsEmail, IsOptional, IsString, Length, Matches, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

export class MfaChallengeDto {
  @IsString()
  mfaToken!: string;

  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
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
