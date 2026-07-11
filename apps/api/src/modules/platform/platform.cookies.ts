import type { CookieOptions, Response } from 'express';
import type { Env } from '@common';

/**
 * Vendor-console session cookies (blueprint §24). Distinct names from the tenant
 * cookies (`access_token`/`csrf`) so that — since both share COOKIE_DOMAIN — a platform
 * session and a tenant session can coexist in one browser without the tenant guards
 * ever seeing a platform token (or vice-versa). httpOnly + SameSite=Strict; `csrf` is
 * the only JS-readable one (double-submit CSRF).
 */
export const PLATFORM_ACCESS_COOKIE = 'platform_access_token';
export const PLATFORM_REFRESH_COOKIE = 'platform_refresh_token';
export const PLATFORM_CSRF_COOKIE = 'platform_csrf';
/** The refresh cookie is path-limited to its endpoint so it isn't sent on every request. */
export const PLATFORM_REFRESH_PATH = '/api/v1/platform/auth/refresh';

function base(env: Env): CookieOptions {
  return { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'strict', domain: env.COOKIE_DOMAIN, path: '/' };
}

export function setPlatformAccessCookie(res: Response, env: Env, token: string, maxAgeMs: number): void {
  res.cookie(PLATFORM_ACCESS_COOKIE, token, { ...base(env), maxAge: maxAgeMs });
}

export function setPlatformRefreshCookie(res: Response, env: Env, token: string, maxAgeMs: number): void {
  res.cookie(PLATFORM_REFRESH_COOKIE, token, { ...base(env), path: PLATFORM_REFRESH_PATH, maxAge: maxAgeMs });
}

export function setPlatformCsrfCookie(res: Response, env: Env, token: string): void {
  res.cookie(PLATFORM_CSRF_COOKIE, token, { ...base(env), httpOnly: false });
}

export function clearPlatformCookies(res: Response, env: Env): void {
  res.clearCookie(PLATFORM_ACCESS_COOKIE, { ...base(env) });
  res.clearCookie(PLATFORM_REFRESH_COOKIE, { ...base(env), path: PLATFORM_REFRESH_PATH });
  res.clearCookie(PLATFORM_CSRF_COOKIE, { ...base(env), httpOnly: false });
}
