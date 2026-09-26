import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { AppError, ErrorCodes, IS_PUBLIC } from '@common';
import { ACCESS_COOKIE, CSRF_COOKIE } from '../auth.cookies';

/**
 * Constant-time string compare (audit 4.1). `timingSafeEqual` requires equal-length buffers, so
 * both sides are hashed to a fixed 32 bytes first — this also lets us compare without leaking the
 * raw length. A plain `!==` short-circuits on the first differing byte, leaking a timing signal.
 */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

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
    if (!header || !cookie || !safeEqual(header, cookie)) {
      throw new AppError(ErrorCodes.CSRF_INVALID, HttpStatus.FORBIDDEN, 'CSRF token missing or invalid');
    }
    return true;
  }
}
