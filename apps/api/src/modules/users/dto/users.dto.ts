import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEmail, IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Role, UserStatus } from '@prisma/client';

/** Staff/admin roles an owner (or campus admin) may provision. PARENT/STUDENT are
 *  auto-created by admissions/portal flows, not from this screen. */
export const MANAGEABLE_ROLES: Role[] = [Role.OWNER_ADMIN, Role.OPERATIONS_ADMIN, Role.CAMPUS_ADMIN, Role.ADMISSION_CONTROLLER, Role.ACCOUNTANT, Role.TEACHER, Role.STAFF];

/** Access-capability roles an owner may toggle on an EXISTING employee (reusing their
 *  login — no new credentials). Their base identity (TEACHER/STAFF) and OWNER_ADMIN are
 *  never toggled here. OPERATIONS_ADMIN (the owner's deputy) is grantable here too — only by the
 *  owner (the grant-ceiling in UsersService forbids a deputy from granting its own level or above). */
export const ACCESS_GRANTABLE_ROLES: Role[] = [Role.OPERATIONS_ADMIN, Role.HR_MANAGER, Role.CAMPUS_ADMIN, Role.ACCOUNTANT, Role.ADMISSION_CONTROLLER];

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

export class SetAccessDto {
  /** The access capability to toggle on an existing employee. */
  @IsIn(ACCESS_GRANTABLE_ROLES) role!: Role;

  /** true = grant the role on the existing employee; false = revoke it. */
  @IsBoolean() grant!: boolean;
}

export class SetAdmissionOfficerDto {
  /** The employee (already on this campus) who takes the campus's admission seat. */
  @IsUUID() userId!: string;
}

export class SetModuleAccessDto {
  /** A module key from the catalog (e.g. 'recruitment.hire'). */
  @IsString() @MinLength(1) @MaxLength(120) moduleKey!: string;

  /** true = the module is on for this user; false = switched off. */
  @IsBoolean() allowed!: boolean;
}

export class BulkDeleteUsersDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsUUID('4', { each: true })
  ids!: string[];
}
