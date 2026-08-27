import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AppError, ErrorCodes, type RequestUser } from '@common';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * SA5 read-only break-glass. A vendor "login-as" session (SA-P8) may only READ the school it
 * entered — never mutate it. Runs after JwtAuthGuard (req.user is set) and refuses any non-safe
 * method for a break-glass session: reproducing a support issue needs reads; a write would be the
 * vendor changing a school's records under an owner's identity. Belt-and-braces alongside CSRF (a
 * break-glass session is issued without a csrf cookie), so writes are blocked two independent ways.
 */
@Injectable()
export class BreakGlassReadonlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { user?: RequestUser }>();
    if (req.user?.breakGlass && !SAFE_METHODS.has(req.method)) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Break-glass sessions are read-only');
    }
    return true;
  }
}
