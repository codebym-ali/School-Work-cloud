import type { CookieOptions, Response } from 'express';
import type { Env } from '@common';

/**
 * Vendor-console session cookies (blueprint §24). Distinct names from the tenant cookies
 * (`access_token`/`csrf`) so a platform session and a tenant session can coexist in one browser
 * without the tenant guards ever seeing a platform token (or vice-versa). httpOnly +
 * SameSite=Strict; `csrf` is the only JS-readable one (double-submit CSRF).
 *
 * ⚠️ **HOST-ONLY, unlike the tenant cookies, and deliberately so.** The tenant cookies carry
 * `Domain=<apex>` because a staff session must survive the move between `demo.<apex>` and
 * `owner.demo.<apex>` — sharing is the feature there. The vendor console has no such need: it
 * lives at exactly one host, and `@sw/api-client` calls `/api/v1` relative to the page, so the
 * cookie is never needed anywhere else.
 *
 * With a Domain the browser attached this cookie to **every request to every tenant subdomain** —
 * including hosts a school controls the content of. Nothing could spend it there (the tenant
 * guards read different names), but the account that can provision and suspend tenants should not
 * have the widest transmission scope in the system. Least exposure, not least effort.
 *
 * ⚠️ One visible consequence: `admin.<apex>` is an alias for the console, and a session opened at
 * `superadmin.<apex>` does NOT carry over to it. Pick one host and stay on it.
 */
export const PLATFORM_ACCESS_COOKIE = 'platform_access_token';
export const PLATFORM_REFRESH_COOKIE = 'platform_refresh_token';
export const PLATFORM_CSRF_COOKIE = 'platform_csrf';
/** The refresh cookie is path-limited to its endpoint so it isn't sent on every request. */
export const PLATFORM_REFRESH_PATH = '/api/v1/platform/auth/refresh';

function base(env: Env): CookieOptions {
  // No `domain` at any tier — see the note above. Omitting it makes the cookie host-only, which is
  // also what `localhost` needed anyway (browsers reject a single-label Domain attribute).
  return { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'strict', path: '/' };
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
