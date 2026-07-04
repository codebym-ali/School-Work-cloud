import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppError, ErrorCodes, IS_PUBLIC } from '@common';
import { ACCESS_COOKIE, CSRF_COOKIE } from '../auth.cookies';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF (blueprint §22.7): on state-changing requests that carry an
 * auth cookie, the `X-CSRF-Token` header must equal the non-httpOnly `csrf` cookie.
 * Skipped for safe methods, @Public routes (HMAC webhooks / login establishing the
 * session), and unauthenticated requests (no ambient session to abuse).
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const cookies = (req.cookies as Record<string, string> | undefined) ?? {};
    if (!cookies[ACCESS_COOKIE]) return true; // no session -> nothing to forge

    const header = req.header('x-csrf-token');
    const cookie = cookies[CSRF_COOKIE];
    if (!header || !cookie || header !== cookie) {
      throw new AppError(ErrorCodes.CSRF_INVALID, HttpStatus.FORBIDDEN, 'CSRF token missing or invalid');
    }
    return true;
  }
}
