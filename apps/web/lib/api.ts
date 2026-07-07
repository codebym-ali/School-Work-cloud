/**
 * API client for the school-management backend. Calls are same-origin (`/api/v1/*`);
 * the browser sends the httpOnly session cookies automatically (credentials: include),
 * and this client attaches the CSRF double-submit header for state-changing requests
 * (reads the non-httpOnly `csrf` cookie, blueprint §22.2).
 */
const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

function csrfToken(): string {
  if (typeof document === 'undefined') return '';
  const m = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

async function request<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken();

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code, err?.message ?? res.statusText);
  }
  return data as T;
}

export interface Me {
  id: string;
  email: string;
  roles: string[];
  campusId: string | null;
}

export interface Dashboard {
  enrollmentCount: number;
  todayAttendancePercent: number | null;
  monthCollections: number;
  defaulterCount: number;
  pendingLeaves: number;
  failedSmsCount: number;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ user: Me; mfaEnrollmentRequired?: boolean }>('/auth/login', { method: 'POST', body: { email, password } }),
  logout: () => request<null>('/auth/logout', { method: 'POST' }),
  me: () => request<Me>('/auth/me'),
  dashboard: () => request<Dashboard>('/dashboard'),
};
