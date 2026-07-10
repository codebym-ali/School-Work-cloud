import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { AppError, ErrorCodes } from '@common';
import { TokenService } from '../auth/token.service';
import { PLATFORM_ACCESS_COOKIE, PLATFORM_CSRF_COOKIE } from './platform.cookies';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface PlatformActor {
  id: string;
}

type PlatformRequest = Request & { platformUser?: PlatformActor };

/**
 * Guards the vendor console (blueprint §24). Validates the platform access token from
 * its httpOnly cookie and enforces the double-submit CSRF header on state-changing
 * methods. Applied explicitly via `@UseGuards` on platform routes — it runs AFTER the
 * global tenant guards, which the platform routes skip by being `@Public`.
 */
@Injectable()
export class PlatformAuthGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  canActivate(context: ExecutionContext): boolean {
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

    req.platformUser = { id: claims.sub };
    return true;
  }
}

/** Injects the authenticated platform actor attached by PlatformAuthGuard. */
export const CurrentPlatformUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): PlatformActor => {
  const req = ctx.switchToHttp().getRequest<PlatformRequest>();
  return req.platformUser as PlatformActor;
});
