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
 * A single-label domain (e.g. `localhost`) is rejected by browsers as a cookie `Domain`
 * attribute, so the session cookie is silently dropped and the app bounces back to login.
 * Emit a HOST-ONLY cookie there (no Domain) — it then works at `localhost` AND any
 * `*.localhost` tenant host in dev. A real apex (`school.com`) keeps its Domain so the
 * cookie is shared across tenant subdomains in production (blueprint §22.2).
 */
function cookieDomain(configured: string): string | undefined {
  return configured.includes('.') ? configured : undefined;
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

export function clearAuthCookies(res: Response, env: Env): void {
  res.clearCookie(ACCESS_COOKIE, { ...base(env) });
  res.clearCookie(REFRESH_COOKIE, { ...base(env), path: REFRESH_PATH });
  res.clearCookie(CSRF_COOKIE, { ...base(env), httpOnly: false });
}
