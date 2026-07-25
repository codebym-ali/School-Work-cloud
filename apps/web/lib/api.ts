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
    public requestId?: string,
  ) {
    super(message);
  }
  /** Field-level validation issues from a 422 (each `issue` names its field in the text). */
  get fieldIssues(): string[] {
    return Array.isArray(this.details)
      ? (this.details as Array<{ field?: string; issue?: string }>).map((d) => d.issue ?? '').filter(Boolean)
      : [];
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
    const err = (data as { error?: { code?: string; message?: string; details?: unknown; requestId?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code, err?.message ?? res.statusText, err?.details, err?.requestId);
  }
  return data as T;
}

export const apiGet = <T>(path: string) => request<T>(path);
export const apiPost = <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
  request<T>(path, { method: 'POST', body, headers });
export const apiPut = <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body });
export const apiPatch = <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body });
export const apiDelete = <T>(path: string, body?: unknown) => request<T>(path, { method: 'DELETE', body });

export function idemKey(): Record<string, string> {
  return { 'Idempotency-Key': crypto.randomUUID() };
}

// ── Types ──────────────────────────────────────────────────────────────────
export interface Me { id: string; email: string; roles: string[]; campusId: string | null; modules: string[]; mfaEnabled: boolean }
/** Login either establishes a session, or (when the account has MFA on) hands back a short-lived
 *  `mfaToken` that must be exchanged for a session via `api.mfa.challenge`. */
export type LoginResult =
  | { user: Me; mfaEnrollmentRequired?: boolean }
  | { mfaRequired: true; mfaToken: string };
export const isMfaRequired = (r: LoginResult): r is { mfaRequired: true; mfaToken: string } =>
  'mfaRequired' in r && r.mfaRequired === true;
export interface UserModule { key: string; label: string; description: string; role: string; allowed: boolean }
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
export interface Student { id: string; fullName: string; grNumber: string; registrationNo: string | null; gender: string; isActive: boolean }
export interface StudentDetail {
  id: string; fullName: string; grNumber: string; registrationNo: string | null; gender: string; dateOfBirth: string; isActive: boolean;
  guardians: { id: string; relation: string; isPrimary: boolean; parent: { id: string; fullName: string; phone: string } }[];
  enrollments: { id: string; classId: string; sectionId: string; campusId: string; academicYearId: string; rollNumber: number | null; status: string; startedAt: string }[];
}
export interface ImportRowError { row: number; field?: string; message: string }
export interface ImportResult {
  rows: number; imported: number; failed: number; dryRun: boolean;
  errors: ImportRowError[];
  students: { row: number; studentId: string; grNumber: string }[];
}
export interface Enrollment { id: string; studentId: string; sectionId: string; classId: string; academicYearId: string; status: string; student?: { fullName: string; grNumber: string } }
export interface Invoice { id: string; studentId: string; totalAmount: string; paidAmount: string; status: string; month: number | null; year: number; dueDate: string }
export interface FeeHead { id: string; name: string }
export interface FeeStructure {
  id: string; campusId: string; classId: string; feeHeadId: string; academicYearId: string;
  amount: string; frequency: string; isActive: boolean;
}
export interface LateFeePolicy { id: string; graceDays: number; mode: string; amount: string; maxAmount: string | null }
export interface Discount {
  id: string; studentId: string; type: string; value: string; feeHeadId: string | null;
  reason: string; status: string; validFrom: string | null;
}
/** Existing-parent match for the direct-admission "link?" step (§8). */
export interface ParentMatch { id: string; fullName: string; phone: string }
/** Direct admission (§8): the AC's single-form student create. Guardian is an EXPLICIT
 *  LINK (an existing parent found by phone) or CREATE — the server never auto-merges. */
export interface DirectAdmissionBody {
  fullName: string; gender: string; dateOfBirth: string;
  campusId: string; classId: string; sectionId: string;
  guardian: { mode: 'LINK' | 'CREATE'; parentId?: string; fullName?: string; phone?: string; relation: string; cnic?: string; email?: string };
  cnic?: string; ageOverride?: boolean; grNumber?: string; rollNumber?: number;
}
export interface AdmissionResult { studentId: string; grNumber: string; registrationNo: string | null; loginProvisioned: boolean }
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

// ── Student self-service portal (§28) ────────────────────────────────────────
export interface PortalOverview {
  student: { fullName: string; grNumber: string; gender: string; dateOfBirth: string };
  enrollment: { className: string; sectionName: string; rollNumber: number | null; year: string } | null;
  guardians: Array<{ name: string; phone: string; relation: string; isPrimary: boolean }>;
  attendancePercent: number | null;
  outstandingFees: number;
  reportCards: number;
}
export interface PortalAttendance { date: string; session: string; status: string }
export interface PortalResult { term: string; overallPercent: number; grade: string; sectionRank: number | null }
export interface PortalFee { id: string; month: number | null; year: number; total: number; paid: number; remaining: number; status: string; dueDate: string }

export interface ManagedUser { id: string; email: string; roles: string[]; campusId: string | null; campusName: string | null; status: string }

// ── Staff / Teachers (HR, §13) ───────────────────────────────────────────────
export interface ManagedTeacher {
  id: string; staffType: string; employeeCode: string; designation: string;
  employmentStatus: string; joinedAt: string;
  user: { id: string; email: string; roles: string[]; status: string; campusId: string | null; campus: { name: string } | null };
}
export interface TeacherAssignment { id: string; staffId: string; academicYearId: string; sectionId: string; subjectId: string | null }

// ── Teacher applications (HR module) ─────────────────────────────────────────
export interface TeacherExperience { schoolName: string; position?: string; subjectsTaught?: string; gradesTaught?: string; duration?: string; reasonForLeaving?: string }
export interface TeacherDetails {
  fatherName: string; dateOfBirth: string; gender: string; cnic: string; maritalStatus?: string; nationality?: string; photoUrl?: string;
  whatsapp?: string; currentAddress: string; permanentAddress?: string; city: string; province?: string; postalCode?: string;
  preferredSubjects?: string; gradeLevels?: string;
  highestQualification: string; degreeTitle?: string; majorSubject?: string; university?: string; passingYear?: number; cgpa?: string;
  totalExperience?: string; experiences?: TeacherExperience[];
  languages?: string; computerSkills?: string; lmsExperience?: string; msOfficeSkills?: string; classroomManagement?: string;
}
export interface TeacherApplicationSummary {
  id: string; campusId: string; campusName: string | null;
  fullName: string; email: string; mobile: string;
  positionAppliedFor: string; department: string; employmentType: string;
  expectedSalary: string | null; availableJoiningDate: string | null; status: string; createdAt: string;
}
export interface TeacherApplicationDetail extends TeacherApplicationSummary { details: TeacherDetails }
export interface CreateTeacherApplicationBody {
  campusId: string; fullName: string; email: string; mobile: string; positionAppliedFor: string; department: string;
  employmentType: string; expectedSalary?: number; availableJoiningDate?: string; details: TeacherDetails;
}

// ── Recruitment (HR module) ──────────────────────────────────────────────────
export interface Vacancy {
  id: string; campusId: string; campusName: string | null;
  title: string; department: string; description: string;
  employmentType: string; positions: number; status: string;
  closedAt: string | null; createdAt: string;
}

export type ApplicationStatus = 'SUBMITTED' | 'SHORTLISTED' | 'REJECTED' | 'HIRED';
export interface HireApplicantBody { employeeCode: string; designation?: string; joinedAt?: string; staffType?: string }
export interface HiredResult extends TeacherApplicationSummary { staff: { userId: string; staffId: string; employeeCode: string } }

export interface AdmissionsSummary {
  byStatus: Record<string, number>;
  totals: { total: number; open: number; testsScheduled: number; readyToAdmit: number; admitted: number };
  testsToday: number;
  admittedThisMonth: number;
  conversionRate: number;
}

export interface RecruitmentSummary {
  vacanciesByStatus: Record<string, number>;
  openVacancies: number;
  openPositions: number;
  applicationsByStatus: Record<string, number>;
  newApplicationsThisWeek: number;
  hiredThisMonth: number;
}

export interface ParentChild {
  studentId: string; fullName: string; grNumber: string; registrationNo: string | null;
  relation: string; isPrimary: boolean;
  className: string | null; sectionName: string | null; rollNumber: number | null;
  attendancePercent: number | null; outstandingFees: number;
}
export interface ParentOverview {
  student: { fullName: string; grNumber: string; registrationNo: string | null; gender: string; dateOfBirth: string };
  enrollment: { className: string; sectionName: string; rollNumber: number | null; year: string } | null;
  guardians: Array<{ name: string; phone: string; relation: string; isPrimary: boolean }>;
  attendancePercent: number | null; outstandingFees: number; reportCards: number;
}

export interface TeacherClass {
  assignmentId: string; sectionId: string; sectionName: string; classId: string | null; className: string;
  academicYearId: string; yearName: string; subjectId: string | null; subjectName: string | null;
  isClassTeacher: boolean; studentCount: number;
}
export interface RosterRow {
  studentId: string; fullName: string; grNumber: string; registrationNo: string | null;
  rollNumber: number | null; enrollmentId: string;
}
export interface StaffAttendanceRow { date: string; session: string; status: string; checkIn: string | null; checkOut: string | null }
export interface Payslip { id: string; runId: string; gross: string; attendanceDeduction: string; otherDeductions: string; netPay: string; status: string; paidAt: string | null }
export interface StaffLeave { id: string; leaveType: string; fromDate: string; toDate: string; reason: string; status: string; isUnpaid: boolean; rejectionReason: string | null; createdAt: string }
export interface StudentLeave { id: string; studentId: string; fromDate: string; toDate: string; reason: string; status: string; rejectionReason: string | null; createdAt: string }

export const api = {
  login: (email: string, password: string) => apiPost<LoginResult>('/auth/login', { email, password }),
  logout: () => apiPost<null>('/auth/logout'),
  me: () => apiGet<Me>('/auth/me'),
  mfa: {
    /** Step 2 of login for an MFA-enabled account — exchanges the pending token for a session. */
    challenge: (mfaToken: string, code: string) => apiPost<{ user: Me }>('/auth/mfa/challenge', { mfaToken, code }),
    /** Starts enrolment: rotates a fresh secret and returns its otpauth:// URI. */
    setup: () => apiPost<{ otpauthUrl: string }>('/auth/mfa/setup'),
    /** Confirms the first code and switches MFA on. */
    verify: (code: string) => apiPost<null>('/auth/mfa/verify', { code }),
    disable: (password: string, code: string) => apiDelete<null>('/auth/mfa', { password, code }),
  },
  dashboard: () => apiGet<Dashboard>('/dashboard'),
  users: {
    list: () => apiGet<ManagedUser[]>('/users'),
    create: (body: { email: string; roles: string[]; campusId?: string; password: string }) => apiPost<ManagedUser>('/users', body),
    update: (id: string, body: { roles?: string[]; campusId?: string; status?: string }) => apiPatch<ManagedUser>(`/users/${id}`, body),
    remove: (id: string) => apiDelete<null>(`/users/${id}`),
    bulkDelete: (ids: string[]) => apiPost<{ removed: number; skipped: number }>('/users/bulk-delete', { ids }),
    resetPassword: (id: string, password: string) => apiPost<{ ok: boolean }>(`/users/${id}/reset-password`, { password }),
    setAccess: (id: string, role: string, grant: boolean) => apiPatch<{ id: string; email: string; roles: string[] }>(`/users/${id}/access`, { role, grant }),
    setHrAccess: (id: string, grant: boolean) => apiPatch<{ id: string; email: string; roles: string[] }>(`/users/${id}/access`, { role: 'HR_MANAGER', grant }),
    setCampusAdmin: (id: string, grant: boolean) => apiPatch<{ id: string; email: string; roles: string[] }>(`/users/${id}/access`, { role: 'CAMPUS_ADMIN', grant }),
    modules: (id: string) => apiGet<UserModule[]>(`/users/${id}/modules`),
    setModule: (id: string, moduleKey: string, allowed: boolean) => apiPatch<{ userId: string; moduleKey: string; allowed: boolean }>(`/users/${id}/modules`, { moduleKey, allowed }),
  },
  staff: {
    list: () => apiGet<ManagedTeacher[]>('/staff'),
    create: (body: { email: string; staffType: string; employeeCode: string; designation: string; joinedAt: string; campusId?: string; roles?: string[] }) =>
      apiPost<{ userId: string; staffId: string; employeeCode: string }>('/staff', body),
    myAttendance: () => apiGet<StaffAttendanceRow[]>('/staff-attendance/mine'),
  },
  staffLeaves: {
    // Self-scoped on the server for non-admins → the caller's own leaves only.
    mine: () => apiGet<{ data: StaffLeave[]; total: number }>('/staff-leaves'),
    apply: (body: { leaveType: string; fromDate: string; toDate: string; reason: string }) => apiPost<StaffLeave>('/staff-leaves', body),
    cancel: (id: string) => apiPost<StaffLeave>(`/staff-leaves/${id}/cancel`, {}),
  },
  payslips: {
    mine: () => apiGet<Payslip[]>('/payslips/mine'),
    pdf: (id: string) => apiGet<{ fileKey: string; url: string; expiresInSeconds: number }>(`/payslips/${id}/pdf`),
  },
  teacherAssignments: {
    list: () => apiGet<TeacherAssignment[]>('/teacher-assignments'),
    create: (body: { staffId: string; academicYearId: string; sectionId: string; subjectId?: string }) =>
      apiPost<TeacherAssignment>('/teacher-assignments', body),
    remove: (id: string) => apiDelete(`/teacher-assignments/${id}`),
  },
  subjects: {
    list: (classId: string) => apiGet<Subject[]>(`/subjects?classId=${classId}`),
  },
  terms: {
    remove: (id: string) => apiDelete<{ ok: boolean }>(`/terms/${id}`),
  },
  teacherApplications: {
    list: (params?: { campusId?: string; status?: string; search?: string }) => {
      const qs = new URLSearchParams(Object.entries(params ?? {}).filter(([, v]) => v) as [string, string][]).toString();
      return apiGet<TeacherApplicationSummary[]>(`/teacher-applications${qs ? `?${qs}` : ''}`);
    },
    get: (id: string) => apiGet<TeacherApplicationDetail>(`/teacher-applications/${id}`),
    create: (body: CreateTeacherApplicationBody) => apiPost<TeacherApplicationSummary>('/teacher-applications', body),
    updateStatus: (id: string, status: 'SHORTLISTED' | 'REJECTED', reason?: string) =>
      apiPatch<TeacherApplicationSummary>(`/teacher-applications/${id}/status`, { status, reason }),
    hire: (id: string, body: HireApplicantBody) => apiPost<HiredResult>(`/teacher-applications/${id}/hire`, body, idemKey()),
  },
  vacancies: {
    list: (params?: { campusId?: string; status?: string; department?: string }) => {
      const qs = new URLSearchParams(Object.entries(params ?? {}).filter(([, v]) => v) as [string, string][]).toString();
      return apiGet<Vacancy[]>(`/vacancies${qs ? `?${qs}` : ''}`);
    },
    create: (body: { campusId: string; title: string; department: string; description: string; employmentType: string; positions: number }) =>
      apiPost<Vacancy>('/vacancies', body),
    close: (id: string) => apiPost<Vacancy>(`/vacancies/${id}/close`),
    summary: () => apiGet<RecruitmentSummary>('/vacancies/summary'),
  },
  admissions: {
    summary: () => apiGet<AdmissionsSummary>('/inquiries/summary'),
  },
  students: {
    // Direct admission — ADMISSION_CONTROLLER only. A 422 AGE_OUT_OF_RANGE is retried with ageOverride.
    admit: (body: DirectAdmissionBody) => apiPost<AdmissionResult>('/students', body),
    // Existing-parent lookup by phone for the guardian match→link step.
    findParents: (phone: string) => apiGet<ParentMatch[]>(`/students/parents/search?phone=${encodeURIComponent(phone)}`),
  },
  // Read-only student portal sign-in: registration-no + CNIC (no password), §28/#34.
  studentPortal: {
    login: (registrationNo: string, cnic: string) => apiPost<{ user: Me }>('/portal/auth/login', { registrationNo, cnic }),
  },
  feeSetup: {
    heads: () => apiGet<FeeHead[]>('/fee-heads'),
    createHead: (name: string) => apiPost<FeeHead>('/fee-heads', { name }),
    structures: (classId?: string) => apiGet<FeeStructure[]>(`/fee-structures${classId ? `?classId=${classId}` : ''}`),
    createStructure: (body: { campusId: string; classId: string; feeHeadId: string; academicYearId: string; amount: number; frequency: string }) =>
      apiPost<FeeStructure>('/fee-structures', body),
    lateFeePolicy: () => apiGet<LateFeePolicy | null>('/late-fee-policy'),
    upsertLateFeePolicy: (body: { graceDays: number; mode: string; amount: number; maxAmount?: number }) =>
      apiPut<LateFeePolicy>('/late-fee-policy', body),
    discounts: () => apiGet<Discount[]>('/discounts'),
    createDiscount: (body: { studentId: string; type: string; value: number; feeHeadId?: string; reason: string }) =>
      apiPost<Discount>('/discounts', body),
    revokeDiscount: (id: string) => apiPost<Discount>(`/discounts/${id}/revoke`),
  },
  teaching: {
    myClasses: () => apiGet<TeacherClass[]>('/teaching/my-classes'),
    roster: (sectionId: string) => apiGet<RosterRow[]>(`/teaching/sections/${sectionId}/roster`),
  },
  parent: {
    children: () => apiGet<ParentChild[]>('/parent/children'),
    overview: (studentId: string) => apiGet<ParentOverview>(`/parent/children/${studentId}/overview`),
    attendance: (studentId: string) => apiGet<PortalAttendance[]>(`/parent/children/${studentId}/attendance`),
    results: (studentId: string) => apiGet<PortalResult[]>(`/parent/children/${studentId}/results`),
    fees: (studentId: string) => apiGet<PortalFee[]>(`/parent/children/${studentId}/fees`),
  },
  studentLeaves: {
    // Parent-scoped on the server → only the caller's own children's leaves.
    list: (studentId: string) => apiGet<{ data: StudentLeave[] }>(`/student-leaves?studentId=${studentId}`),
    apply: (body: { studentId: string; fromDate: string; toDate: string; reason: string }) => apiPost<StudentLeave>('/student-leaves', body),
    cancel: (id: string) => apiPost<StudentLeave>(`/student-leaves/${id}/cancel`, {}),
  },
  portal: {
    overview: () => apiGet<PortalOverview>('/portal/overview'),
    attendance: () => apiGet<PortalAttendance[]>('/portal/attendance'),
    results: () => apiGet<PortalResult[]>('/portal/results'),
    fees: () => apiGet<PortalFee[]>('/portal/fees'),
  },
};
