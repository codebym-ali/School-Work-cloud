import type { CookieOptions, Response } from 'express';
import type { Env } from '@common';

/**
 * Token transport (blueprint §22.2): httpOnly + Secure + SameSite=Strict cookies.
 * Nothing token-shaped in JS-readable storage => XSS cannot exfiltrate a session.
 * The refresh cookie is path-limited to the refresh endpoint. `csrf` is the only
 * non-httpOnly cookie (double-submit CSRF, §22.7).
 */
export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';
export const CSRF_COOKIE = 'csrf';
export const REFRESH_PATH = '/api/v1/auth/refresh';

function base(env: Env): CookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'strict',
    domain: cookieDomain(env.COOKIE_DOMAIN),
    path: '/',
  };
}

/**
 * ⚠️ **Host-only at every tier — the session belongs to the DOOR, not to the apex.**
 *
 * This cookie used to carry `Domain=<apex>` so one session was shared across every tenant
 * subdomain. That made sense when the doors were paths inside one app. After the front-end split
 * each door is its own origin with **its own login page** (`staff-web/app/login`,
 * `owner-web/app/login`, `parent-web/app/login`), so a session is always issued on, and read back
 * from, the same host — nothing needed the sharing any more.
 *
 * What the sharing DID do was make the three doors mutually exclusive in one browser: same cookie
 * name, same domain, so signing into the parent portal silently evicted the staff session. An
 * office computer where the clerk cannot have the fee screen and a parent's portal view open at
 * once is a worse outcome than a re-login that no longer happens.
 *
 * ⚠️ **Signing out is therefore per-door too.** Logging out of staff does not end a parent session
 * in the same browser. That is the honest consequence of separate sessions, and the logout copy
 * says so rather than leaving someone to assume otherwise.
 *
 * (A single-label domain such as `localhost` was always emitted host-only anyway — browsers reject
 * it as a `Domain` attribute and the cookie is silently dropped, which is how this first came up.)
 */
function cookieDomain(_configured: string): string | undefined {
  return undefined;
}

export function setAccessCookie(res: Response, env: Env, token: string, maxAgeMs: number): void {
  res.cookie(ACCESS_COOKIE, token, { ...base(env), maxAge: maxAgeMs });
}

export function setRefreshCookie(res: Response, env: Env, token: string, maxAgeMs: number): void {
  res.cookie(REFRESH_COOKIE, token, { ...base(env), path: REFRESH_PATH, maxAge: maxAgeMs });
}

export function setCsrfCookie(res: Response, env: Env, token: string): void {
  res.cookie(CSRF_COOKIE, token, { ...base(env), httpOnly: false });
}

export const ACTIVE_CHILD_COOKIE = 'active_child';

export function setActiveChildCookie(res: Response, env: Env, studentId: string): void {
  res.cookie(ACTIVE_CHILD_COOKIE, studentId, { ...base(env), maxAge: 30 * 24 * 60 * 60 * 1000 });
}

export function clearActiveChildCookie(res: Response, env: Env): void {
  res.clearCookie(ACTIVE_CHILD_COOKIE, { ...base(env) });
}

export function clearAuthCookies(res: Response, env: Env): void {
  res.clearCookie(ACCESS_COOKIE, { ...base(env) });
  res.clearCookie(REFRESH_COOKIE, { ...base(env), path: REFRESH_PATH });
  res.clearCookie(CSRF_COOKIE, { ...base(env), httpOnly: false });
  res.clearCookie(ACTIVE_CHILD_COOKIE, { ...base(env) });
}
