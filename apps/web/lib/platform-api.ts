/**
 * API client for the vendor console (blueprint §24). Same-origin calls to
 * `/api/v1/platform/*`; the browser sends the httpOnly `platform_access_token` cookie
 * automatically, and this client attaches the platform CSRF double-submit header read
 * from the non-httpOnly `platform_csrf` cookie (distinct from the tenant `csrf` cookie
 * so a platform session and a tenant session can coexist in one browser).
 */
import { ApiError } from './api';

const BASE = '/api/v1';

function platformCsrf(): string {
  if (typeof document === 'undefined') return '';
  const m = document.cookie.match(/(?:^|;\s*)platform_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

async function request<T>(path: string, opts: { method?: string; body?: unknown } = {}, retry = true): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (method !== 'GET') headers['X-CSRF-Token'] = platformCsrf();

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  // Access token expired (15m): silently rotate via the refresh cookie once, then retry.
  // `login` and `mfa` run BEFORE a session exists — a 401 there is a bad credential/code, not an
  // expired token, so they must never be retried through the (absent) refresh cookie.
  if (
    res.status === 401 && retry &&
    path !== '/platform/auth/refresh' && path !== '/platform/auth/login' && path !== '/platform/auth/mfa'
  ) {
    const refreshed = await fetch(`${BASE}/platform/auth/refresh`, { method: 'POST', credentials: 'include' });
    if (refreshed.ok) return request<T>(path, opts, false);
  }

  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, err?.code, err?.message ?? res.statusText, err?.details);
  }
  return data as T;
}

// ── Types ──────────────────────────────────────────────────────────────────
/** The operator roles (blueprint §24). Only SUPER_ADMIN may perform writes (provision / suspend /
 *  reactivate); the rest are read-only. The API enforces this with 403; the UI hides the controls. */
export type PlatformRole = 'SUPER_ADMIN' | 'SUPPORT' | 'BILLING' | 'ANALYST';
export interface PlatformUser { id: string; email: string; role: PlatformRole; mfaEnabled: boolean }
/** Sign-in either establishes a session, or (when the account has MFA on) hands back a short-lived
 *  `mfaToken` that must be exchanged for a session via `platformApi.mfaComplete`. Mirrors the tenant
 *  `LoginResult` in `lib/api.ts`. */
export type PlatformLoginResult =
  | { user: PlatformUser }
  | { mfaRequired: true; mfaToken: string };
export const isPlatformMfaRequired = (r: PlatformLoginResult): r is { mfaRequired: true; mfaToken: string } =>
  'mfaRequired' in r && r.mfaRequired === true;
export interface Tenant {
  id: string; name: string; subdomain: string; customDomain: string | null;
  planTier: string; isActive: boolean; suspendedAt: string | null; createdAt: string;
  userCount: number; studentCount: number;
}
export interface NewTenant { name: string; subdomain: string; ownerEmail: string }
export interface TenantPage { data: Tenant[]; total: number; page: number; pageSize: number }
/** Fleet-overview totals for the dashboard (SA1), read from the latest nightly snapshot.
 *  `capturedAt` is null until the first snapshot has been written. */
export interface PlatformOverview {
  capturedAt: string | null;
  schoolsTotal: number;
  schoolsActive: number;
  schoolsSuspended: number;
  studentsActive: number;
  staffEmployed: number;
  newSchools30d: number;
}

export const platformApi = {
  login: (email: string, password: string) =>
    request<PlatformLoginResult>('/platform/auth/login', { method: 'POST', body: { email, password } }),
  /** Step 2 of login for an MFA-enabled operator — exchanges the pending token for a session. A
   *  recovery code may be entered in place of the TOTP `code` (same field, same endpoint). */
  mfaComplete: (mfaToken: string, code: string) =>
    request<{ user: PlatformUser }>('/platform/auth/mfa', { method: 'POST', body: { mfaToken, code } }),
  /** Starts enrolment: returns the otpauth:// URI (render as a key/QR) and its shared secret. */
  mfaEnrollBegin: () =>
    request<{ otpauthUrl: string; secret: string }>('/platform/auth/mfa/enroll/begin', { method: 'POST' }),
  /** Confirms the first code, switches MFA on, and returns the recovery codes ONCE. */
  mfaEnrollConfirm: (code: string) =>
    request<{ recoveryCodes: string[] }>('/platform/auth/mfa/enroll/confirm', { method: 'POST', body: { code } }),
  logout: () => request<null>('/platform/auth/logout', { method: 'POST' }),
  me: () => request<PlatformUser>('/platform/auth/me'),
  tenants: (params: { search?: string; page?: number; pageSize?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.search) qs.set('search', params.search);
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    const q = qs.toString();
    return request<TenantPage>(`/platform/tenants${q ? `?${q}` : ''}`);
  },
  /** Fleet totals for the dashboard — a snapshot read, open to every operator role. */
  overview: () => request<PlatformOverview>('/platform/overview'),
  /** Provision a school. SA2 (SA-P3): no password is sent — the response carries a one-time
   *  `onboardingToken` the console turns into a set-password link for the new owner. */
  provision: (t: NewTenant) => request<{ id: string; subdomain: string; onboardingToken?: string }>('/platform/tenants', { method: 'POST', body: t }),
  suspend: (id: string, reason: string) => request<{ id: string; isActive: boolean }>(`/platform/tenants/${id}/suspend`, { method: 'POST', body: { reason } }),
  reactivate: (id: string) => request<{ id: string; isActive: boolean }>(`/platform/tenants/${id}/reactivate`, { method: 'POST' }),
};
