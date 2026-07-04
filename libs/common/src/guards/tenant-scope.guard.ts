import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from '../decorators/public.decorator';
import { AppError } from '../errors/app.error';
import { ErrorCodes } from '../errors/error-codes';
import { TenantContext, type RequestUser } from '../context/tenant-context';

/**
 * Defence-in-depth (blueprint §19 step 3): asserts the JWT's school (`sid`) equals
 * the tenant resolved from the Host header. A mismatch (e.g. a token minted for
 * school A replayed on school B's subdomain) is rejected BEFORE any DB call.
 */
@Injectable()
export class TenantScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenant: TenantContext,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<{ user?: RequestUser }>();
    const jwtSchool = req.user?.schoolId;
    const resolvedSchool = this.tenant.schoolId;

    if (!jwtSchool || !resolvedSchool || jwtSchool !== resolvedSchool) {
      throw new AppError(ErrorCodes.TENANT_MISMATCH, HttpStatus.FORBIDDEN, 'Tenant mismatch');
    }
    return true;
  }
}
