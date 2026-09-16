import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppError, ErrorCodes, IS_PUBLIC, TenantContext, type RequestUser } from '@common';
import { TokenService } from '../token.service';
import { ACCESS_COOKIE } from '../auth.cookies';
import { AccessDenylist } from '../access-denylist.service';

/**
 * Validates the access JWT from the httpOnly cookie and attaches req.user
 * (blueprint §19 step 2, §22.2). Public routes (@Public) are skipped. Tokens on
 * the short-lived denylist (account-disable / role-downgrade, §22.4) are rejected.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly denylist: AccessDenylist,
    private readonly tenant: TenantContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: RequestUser }>();
    const token = (req.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];
    if (!token) {
      throw new AppError(ErrorCodes.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, 'Not authenticated');
    }

    let claims;
    try {
      claims = this.tokens.verifyAccess(token);
    } catch {
      throw new AppError(ErrorCodes.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, 'Invalid or expired token');
    }

    if (await this.denylist.isDenied(claims.sub)) {
      throw new AppError(ErrorCodes.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, 'Session revoked');
    }

    const principal: RequestUser = {
      userId: claims.sub,
      schoolId: claims.sid,
      roles: claims.roles,
      campusId: claims.cid,
      mfaEnrolled: claims.mfa === true,
      // SA5: a break-glass token carries the acting vendor operator; the pipeline then enforces
      // read-only (BreakGlassReadonlyGuard) and confinement to `sid` (TenantScopeGuard + RLS).
      ...(claims.bg ? { breakGlass: true, vendorOperatorId: claims.vop } : {}),
    };
    req.user = principal;
    // Mirror onto CLS so services/AuditService can read the actor without plumbing it.
    this.tenant.user = principal;
    return true;
  }
}
