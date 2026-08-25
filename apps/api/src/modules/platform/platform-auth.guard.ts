import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { PlatformRole } from '@prisma/client';
import { AppError, ErrorCodes } from '@common';
import { PlatformPrismaService } from '@database';
import { TokenService } from '../auth/token.service';
import { PLATFORM_ACCESS_COOKIE, PLATFORM_CSRF_COOKIE } from './platform.cookies';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface PlatformActor {
  id: string;
  role: PlatformRole;
}

type PlatformRequest = Request & { platformUser?: PlatformActor };

/**
 * Route-level privilege gate (SA0, SA-P6). Marks a platform route as requiring one of the
 * listed roles; PlatformAuthGuard reads it and 403s an operator whose role isn't allowed.
 * SA0 uses only `@PlatformRoles('SUPER_ADMIN')` on writes — reads carry no decorator and are
 * open to any authenticated operator.
 */
export const PLATFORM_ROLES_KEY = 'platformRoles';
export const PlatformRoles = (...roles: PlatformRole[]) => SetMetadata(PLATFORM_ROLES_KEY, roles);

/**
 * Guards the vendor console (blueprint §24). Validates the platform access token from
 * its httpOnly cookie and enforces the double-submit CSRF header on state-changing
 * methods. Applied explicitly via `@UseGuards` on platform routes — it runs AFTER the
 * global tenant guards, which the platform routes skip by being `@Public`.
 */
@Injectable()
export class PlatformAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly platform: PlatformPrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<PlatformRequest>();
    const cookies = (req.cookies as Record<string, string> | undefined) ?? {};
    const token = cookies[PLATFORM_ACCESS_COOKIE];
    if (!token) throw new AppError(ErrorCodes.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, 'Not authenticated');

    let claims: { sub: string };
    try {
      claims = this.tokens.verifyPlatform(token);
    } catch {
      throw new AppError(ErrorCodes.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, 'Invalid or expired token');
    }

    if (!SAFE_METHODS.has(req.method)) {
      const header = req.header('x-csrf-token');
      const cookie = cookies[PLATFORM_CSRF_COOKIE];
      if (!header || !cookie || header !== cookie) {
        throw new AppError(ErrorCodes.CSRF_INVALID, HttpStatus.FORBIDDEN, 'CSRF token missing or invalid');
      }
    }

    // Re-check status every request so disabling an operator revokes access immediately
    // (rather than waiting out the 8h token). The console is low-traffic — one small read.
    // The role is read on the same query so route-level privilege is enforced against the
    // LIVE value, not a stale claim in the token (a demotion takes effect immediately).
    const actor = await this.platform.platformUser.findUnique({
      where: { id: claims.sub },
      select: { status: true, role: true },
    });
    if (!actor || actor.status !== 'ACTIVE') {
      throw new AppError(ErrorCodes.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, 'Session revoked');
    }

    const requiredRoles = this.reflector.getAllAndOverride<PlatformRole[] | undefined>(PLATFORM_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requiredRoles && requiredRoles.length > 0 && !requiredRoles.includes(actor.role)) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Insufficient platform role');
    }

    req.platformUser = { id: claims.sub, role: actor.role };
    return true;
  }
}

/** Injects the authenticated platform actor attached by PlatformAuthGuard. */
export const CurrentPlatformUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): PlatformActor => {
  const req = ctx.switchToHttp().getRequest<PlatformRequest>();
  return req.platformUser as PlatformActor;
});
