import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { IS_PUBLIC } from '../decorators/public.decorator';
import { AppError } from '../errors/app.error';
import { ErrorCodes } from '../errors/error-codes';
import { HttpStatus } from '@nestjs/common';
import type { RequestUser } from '../context/tenant-context';
import { rolesSatisfying } from '../authz/role-hierarchy';

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
    // Expand held roles through the hierarchy: OPERATIONS_ADMIN satisfies requirements for roles below
    // it (never OWNER_ADMIN), so owner-only routes stay reserved by construction (role-hierarchy.ts).
    const effective = rolesSatisfying(req.user?.roles ?? []);
    if (!required.some((r) => effective.has(r))) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Insufficient role');
    }
    return true;
  }
}
