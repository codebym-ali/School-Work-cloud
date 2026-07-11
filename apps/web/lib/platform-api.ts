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
  if (res.status === 401 && retry && path !== '/platform/auth/refresh' && path !== '/platform/auth/login') {
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
export interface PlatformUser { id: string; email: string }
export interface Tenant {
  id: string; name: string; subdomain: string; customDomain: string | null;
  planTier: string; isActive: boolean; suspendedAt: string | null; createdAt: string;
  userCount: number; studentCount: number;
}
export interface NewTenant { name: string; subdomain: string; ownerEmail: string; ownerPassword: string }

export const platformApi = {
  login: (email: string, password: string) =>
    request<{ user: PlatformUser }>('/platform/auth/login', { method: 'POST', body: { email, password } }),
  logout: () => request<null>('/platform/auth/logout', { method: 'POST' }),
  me: () => request<PlatformUser>('/platform/auth/me'),
  tenants: () => request<Tenant[]>('/platform/tenants'),
  provision: (t: NewTenant) => request<{ id: string; subdomain: string }>('/platform/tenants', { method: 'POST', body: t }),
  suspend: (id: string) => request<{ id: string; isActive: boolean }>(`/platform/tenants/${id}/suspend`, { method: 'POST' }),
  reactivate: (id: string) => request<{ id: string; isActive: boolean }>(`/platform/tenants/${id}/reactivate`, { method: 'POST' }),
};
