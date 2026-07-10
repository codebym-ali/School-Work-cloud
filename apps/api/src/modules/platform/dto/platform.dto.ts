import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

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

  @IsString() @MinLength(8) @MaxLength(200)
  ownerPassword!: string;
}
