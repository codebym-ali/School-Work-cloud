import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../errors/app.error';
import { ErrorCodes } from '../errors/error-codes';
import type { RequestUser } from '../context/tenant-context';
import { MANDATORY_MFA_ROLES, REQUIRES_MFA_KEY } from '../decorators/requires-mfa.decorator';

/**
 * Enforces two-factor on `@RequiresMfa()` routes for the roles that must have it.
 *
 * ⚠️ **Until 2026-09-16 the requirement was a banner and nothing else.** Login returned
 * `mfaEnrollmentRequired` and the shell rendered "Two-factor authentication is required for your
 * role" in red — while no code anywhere enforced it, so it could be ignored indefinitely. A red
 * warning that costs nothing to ignore teaches people that red warnings are decorative.
 *
 * Reads the enrolment flag from the TOKEN, not the database: guards run before the tenant
 * transaction, where RLS returns no rows.
 *
 * Callers WITHOUT a mandatory-MFA role pass: a campus admin may reveal a CNIC without enrolling,
 * because MFA is not mandatory for that role. This guard enforces an existing policy; it does not
 * widen it. Break-glass sessions are read-only and blocked from writes upstream; they are let
 * through here so a support read is not refused for want of the vendor's own second factor.
 */
@Injectable()
export class MfaEnrolledGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(REQUIRES_MFA_KEY, [context.getHandler(), context.getClass()]);
    if (!required) return true;

    const user = context.switchToHttp().getRequest<{ user?: RequestUser }>().user;
    if (!user || user.breakGlass) return true;

    const mandatory = user.roles.some((r) => MANDATORY_MFA_ROLES.includes(r));
    if (!mandatory || user.mfaEnrolled) return true;

    throw new AppError(
      ErrorCodes.MFA_ENROLMENT_REQUIRED,
      HttpStatus.FORBIDDEN,
      'Set up two-factor authentication before doing this. It takes a minute, under Security.',
    );
  }
}
