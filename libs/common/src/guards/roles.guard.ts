import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { IS_PUBLIC } from '../decorators/public.decorator';
import { AppError } from '../errors/app.error';
import { ErrorCodes } from '../errors/error-codes';
import { HttpStatus } from '@nestjs/common';
import type { RequestUser } from '../context/tenant-context';

/**
 * Role gate (blueprint §23). Runs after JwtAuthGuard + TenantScopeGuard.
 * A route with no @Roles() is allowed for any authenticated user; scope is
 * enforced separately by the ownership guards (§22.8).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<{ user?: RequestUser }>();
    const roles = req.user?.roles ?? [];
    if (!roles.some((r) => required.includes(r))) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Insufficient role');
    }
    return true;
  }
}
