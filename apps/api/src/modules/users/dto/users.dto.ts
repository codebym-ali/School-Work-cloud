import { ArrayMinSize, IsArray, IsEmail, IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Role, UserStatus } from '@prisma/client';

/** Staff/admin roles an owner (or campus admin) may provision. PARENT/STUDENT are
 *  auto-created by admissions/portal flows, not from this screen. */
export const MANAGEABLE_ROLES: Role[] = [Role.OWNER_ADMIN, Role.CAMPUS_ADMIN, Role.ACCOUNTANT, Role.TEACHER, Role.STAFF];

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsArray() @ArrayMinSize(1) @IsEnum(Role, { each: true })
  roles!: Role[];

  /** Required for every role except OWNER_ADMIN (which is school-wide). */
  @IsOptional() @IsUUID()
  campusId?: string;

  /** Initial password the owner sets; the user can change it later. */
  @IsString() @MinLength(10) @MaxLength(200)
  password!: string;
}

export class UpdateUserDto {
  @IsOptional() @IsArray() @ArrayMinSize(1) @IsEnum(Role, { each: true })
  roles?: Role[];

  @IsOptional() @IsUUID()
  campusId?: string;

  @IsOptional() @IsEnum(UserStatus)
  status?: UserStatus;
}

export class ResetUserPasswordDto {
  @IsString() @MinLength(10) @MaxLength(200)
  password!: string;
}
