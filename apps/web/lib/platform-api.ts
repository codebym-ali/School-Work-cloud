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
  planTier: string; isActive: boolean; suspendedAt: string | null; purgeAfter: string | null; createdAt: string;
  userCount: number; activeStudents: number;
}
/** A tenant data export (SA7) — sensitive columns redacted. */
export interface TenantExport { schoolId: string; subdomain: string; generatedAt: string; rowCounts: Record<string, number>; tables: Record<string, unknown[]> }
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
/** Per-plan entitlement limits (SA3), from the server-side catalog. */
export interface PlanLimits {
  maxStudents: number;
  maxStaff: number;
  maxCampuses: number;
  storageMb: number;
  monthlySmsCredits: number;
}
export type PlanCatalog = Record<string, PlanLimits>;
/** A vendor operator as the console lists it (SA4). */
export interface PlatformOperator {
  id: string;
  email: string;
  name: string;
  role: PlatformRole;
  status: string;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}
/** Invite a new operator (SA4b). */
export interface NewOperator { email: string; name?: string; role: string }

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
  /** The plan catalog (SA3) — per-tier limits, an open read. */
  plans: () => request<PlanCatalog>('/platform/plans'),
  /** Change a tenant's plan (SA3, SUPER_ADMIN) — audited. */
  changePlan: (id: string, planTier: string) =>
    request<{ id: string; planTier: string }>(`/platform/tenants/${id}/plan`, { method: 'PATCH', body: { planTier } }),
  /** The vendor operators (SA4, SUPER_ADMIN). */
  operators: () => request<PlatformOperator[]>('/platform/operators'),
  /** Change an operator's role and/or status (SA4, SUPER_ADMIN) — audited. */
  updateOperator: (id: string, changes: { role?: string; status?: 'ACTIVE' | 'DISABLED' }) =>
    request<PlatformOperator>(`/platform/operators/${id}`, { method: 'PATCH', body: changes }),
  /** Invite a new operator (SA4b, SUPER_ADMIN) — returns a one-time onboarding token. */
  createOperator: (op: NewOperator) =>
    request<{ id: string; email: string; onboardingToken: string }>('/platform/operators', { method: 'POST', body: op }),
  /** Public: an INVITED operator sets their own password via the onboarding token (SA4b). */
  setPassword: (token: string, newPassword: string) =>
    request<null>('/platform/auth/set-password', { method: 'POST', body: { token, newPassword } }),
  /** Start a break-glass "login-as" session into a school (SA5, SUPER_ADMIN/SUPPORT) — returns a
   *  short-lived, read-only token scoped to that one school. */
  breakGlass: (id: string, reason: string) =>
    request<{ schoolId: string; subdomain: string; token: string; expiresAt: string }>(`/platform/tenants/${id}/break-glass`, { method: 'POST', body: { reason } }),
  // ── Tenant offboarding (SA7, SUPER_ADMIN) ────────────────────────────────────
  /** Schedule a reversible termination (retention window). */
  terminate: (id: string, reason: string) =>
    request<{ id: string; purgeAfter: string }>(`/platform/tenants/${id}/terminate`, { method: 'POST', body: { reason } }),
  cancelTermination: (id: string) =>
    request<{ id: string; isActive: boolean }>(`/platform/tenants/${id}/cancel-termination`, { method: 'POST' }),
  /** Full redacted data export — the handover before offboarding. */
  exportTenant: (id: string) => request<TenantExport>(`/platform/tenants/${id}/export`),
  /** IRREVERSIBLE hard-delete — only after the retention window, with a subdomain confirmation. */
  purge: (id: string, confirmSubdomain: string) =>
    request<{ id: string; deleted: Record<string, number> }>(`/platform/tenants/${id}/purge`, { method: 'POST', body: { confirmSubdomain } }),
};
