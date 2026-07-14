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
    public details?: unknown,
  ) {
    super(message);
  }
}

function csrfToken(): string {
  if (typeof document === 'undefined') return '';
  const m = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

async function request<T>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts.headers };
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken();

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, err?.code, err?.message ?? res.statusText, err?.details);
  }
  return data as T;
}

export const apiGet = <T>(path: string) => request<T>(path);
export const apiPost = <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
  request<T>(path, { method: 'POST', body, headers });
export const apiPut = <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body });
export const apiPatch = <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body });

export function idemKey(): Record<string, string> {
  return { 'Idempotency-Key': crypto.randomUUID() };
}

// ── Types ──────────────────────────────────────────────────────────────────
export interface Me { id: string; email: string; roles: string[]; campusId: string | null }
export interface Dashboard {
  enrollmentCount: number; todayAttendancePercent: number | null; monthCollections: number;
  defaulterCount: number; pendingLeaves: number | null; failedSmsCount: number | null;
  /** Metric keys this role should see — the UI renders only these cards (role-shaping). */
  visible: string[];
}
export interface Paged<T> { data: T[]; total: number; page: number; pageSize: number }
export interface Campus { id: string; name: string }
export interface AcademicYear { id: string; name: string; isCurrent: boolean }
export interface Klass { id: string; name: string; order: number; campusId: string }
export interface Section { id: string; name: string; classId: string }
export interface Student { id: string; fullName: string; grNumber: string; gender: string; isActive: boolean }
export interface ImportRowError { row: number; field?: string; message: string }
export interface ImportResult {
  rows: number; imported: number; failed: number; dryRun: boolean;
  errors: ImportRowError[];
  students: { row: number; studentId: string; grNumber: string }[];
}
export interface Enrollment { id: string; studentId: string; sectionId: string; classId: string; academicYearId: string; status: string; student?: { fullName: string; grNumber: string } }
export interface Invoice { id: string; studentId: string; totalAmount: string; paidAmount: string; status: string; month: number | null; year: number; dueDate: string }
export interface EntryTest { id: string; inquiryId: string; scheduledAt: string; score: string | null; remarks: string | null }
export interface Inquiry {
  id: string; campusId: string; guardianName: string; guardianPhone: string; studentName: string;
  desiredClassId: string; status: string; statusReason: string | null; createdAt: string;
  entryTest?: EntryTest | null; admission?: { id: string; studentId: string } | null;
}
export interface Subject { id: string; name: string; classId: string }
export interface Term { id: string; name: string; academicYearId: string; startDate: string; endDate: string }
export interface GradeBand { label: string; minPercent: string; maxPercent: string; gradePoint: string }
export interface Exam { id: string; termId: string; classId: string; name: string; examType: string; weightagePercent: string; examDate: string; status: string }
export interface ExamResult {
  id: string; examId: string; enrollmentId: string; subjectId: string;
  marksObtained: string | null; totalMarks: string; isAbsent: boolean;
  subject?: { name: string }; enrollment?: { studentId: string; sectionId: string };
}
export interface ReportCard {
  id: string; termId: string; enrollmentId: string;
  overallPercent: string; gradeLabel: string; sectionRank: number | null; documentId: string;
}

export const api = {
  login: (email: string, password: string) =>
    apiPost<{ user: Me; mfaEnrollmentRequired?: boolean }>('/auth/login', { email, password }),
  logout: () => apiPost<null>('/auth/logout'),
  me: () => apiGet<Me>('/auth/me'),
  dashboard: () => apiGet<Dashboard>('/dashboard'),
};
