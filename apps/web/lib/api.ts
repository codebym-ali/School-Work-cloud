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
/** `admissionsMode` is a school-level setting: DIRECT hides the enquiry pipeline entirely
 *  (the form IS the admission), PIPELINE restores lead → entry test → admit. */
export interface Me { id: string; email: string; roles: string[]; campusId: string | null; modules: string[]; mfaEnabled: boolean; admissionsMode: 'DIRECT' | 'PIPELINE' }
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
/** Shared vocabulary with the API and the student portal, so the ranges never diverge. */
export const PERFORMANCE_RANGES = ['1w', '1m', '2m', '3m', '6m'] as const;
export type PerformanceRange = (typeof PERFORMANCE_RANGES)[number];
export const RANGE_LABEL: Record<PerformanceRange, string> = {
  '1w': 'Last week', '1m': '1 month', '2m': '2 months', '3m': '3 months', '6m': '6 months',
};
/** `percent` is null when nothing was sat — distinct from 0%, which means marks of zero. */
export interface PerfSummary {
  percent: number | null; testsTaken: number; testsMissed: number;
  marksObtained: number; marksTotal: number;
}
export interface ClassPerformance extends PerfSummary {
  classId: string; className: string; order: number; students: number; trend: number | null;
}
export interface ClassStudents {
  classId: string; className: string;
  students: (PerfSummary & {
    studentId: string; fullName: string; grNumber: string; trend: number | null;
    weakestSubject: { name: string; percent: number | null } | null;
  })[];
}
export interface StudentPerformance {
  studentId: string; fullName: string; grNumber: string;
  className: string | null; sectionName: string | null;
  overall: PerfSummary;
  monthly: (PerfSummary & { month: string })[];
  subjects: (PerfSummary & {
    subjectId: string; subjectName: string;
    tests: { id: string; name: string; testDate: string; totalMarks: number; marksObtained: number | null; isAbsent: boolean }[];
  })[];
}

export interface Paged<T> { data: T[]; total: number; page: number; pageSize: number }
export interface Campus { id: string; name: string; address?: string | null }
export interface AcademicYear { id: string; name: string; isCurrent: boolean }
export interface Klass { id: string; name: string; order: number; campusId: string; createdAt?: string; minAgeYears?: number | null; maxAgeYears?: number | null }
/** `subjectIds` empty ⇒ the section studies every subject its class offers. */
export interface Section { id: string; name: string; classId: string; subjectIds?: string[]; capacity: number; enrolled?: number | null }
export type StudentStatus = 'ACTIVE' | 'SUSPENDED' | 'RESTRICTED' | 'STRUCK_OFF' | 'WITHDRAWN' | 'GRADUATED';
/** `hasGuardian: false` means nobody is contactable for this child — no absence, fee-receipt
 *  or result SMS can be sent. Surfaced in the directory so the gap can be chased. */
export interface Student { id: string; fullName: string; grNumber: string; registrationNo: string | null; gender: string; isActive: boolean; status: StudentStatus; statusReason: string | null; statusEndsOn: string | null; hasGuardian: boolean }
export interface StudentDetail {
  id: string; fullName: string; grNumber: string; registrationNo: string | null; gender: string; dateOfBirth: string; isActive: boolean;
  status: StudentStatus; statusReason: string | null; statusEffectiveFrom: string | null; statusEndsOn: string | null;
  /** A CNIC is on record. The value is never in this payload — fetch it via `api.students.revealCnic`. */
  hasCnic: boolean;
  /** False for a CNIC captured before the encrypted column existed: it still verifies a login
   *  but cannot be read back, which is a different thing from "not provided". */
  cnicRevealable: boolean;
  /** The student can sign in to the read-only portal with their registration number + CNIC. */
  portalLoginEnabled: boolean;
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
/** Direct admission (§8): the AC's single-form student create. Guardian is OPTIONAL — omit it
 *  to admit now and record the guardian later — but when present it is an EXPLICIT LINK (an
 *  existing parent found by phone) or CREATE; the server never auto-merges. */
export interface DirectAdmissionBody {
  fullName: string; gender: string; dateOfBirth: string;
  campusId: string; classId: string; sectionId: string;
  guardian?: { mode: 'LINK' | 'CREATE'; parentId?: string; fullName?: string; phone?: string; relation: string; cnic?: string; email?: string };
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
export interface SubjectCatalogueEntry { name: string; classCount: number }
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
  student: {
    fullName: string; grNumber: string; gender: string; dateOfBirth: string;
    status: StudentStatus; statusReason: string | null; statusEndsOn: string | null;
  };
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

/** A campus and whoever currently holds its admission seat (`officer: null` = vacant). */
export interface CampusAdmissionOfficer {
  campusId: string; campusName: string;
  officer: { id: string; email: string; status: string } | null;
}
export interface SetOfficerResult {
  campusId: string;
  officer: { id: string; email: string };
  /** The outgoing holder when this was a handover, else null — lets the UI say who lost it. */
  previous: { id: string; email: string } | null;
}

// ── Staff / Teachers (HR, §13) ───────────────────────────────────────────────
export interface ManagedTeacher {
  id: string; staffType: string; employeeCode: string; fullName: string | null; designation: string;
  employmentStatus: string; joinedAt: string;
  user: { id: string; email: string; roles: string[]; status: string; campusId: string | null; campus: { name: string } | null };
}
/** `subjectId: null` is the homeroom (class-teacher) assignment, not a subject.
 *  The list is scoped to one academic year — the current one unless another is asked for. */
export interface TeacherAssignment {
  id: string; staffId: string; academicYearId: string; sectionId: string; subjectId: string | null;
  /** Resolved server-side so a caller rendering "Maths · A. Khan" needn't load the staff directory. */
  teacherName: string;
}

// ── Teacher applications (HR module) ─────────────────────────────────────────
export interface TeacherExperience { schoolName: string; position?: string; subjectsTaught?: string; gradesTaught?: string; duration?: string; reasonForLeaving?: string }
export interface TeacherEducation { qualification: string; degreeTitle?: string; majorSubject?: string; university?: string; passingYear?: number; cgpa?: string }
export interface TeacherDetails {
  fatherName?: string; dateOfBirth?: string; gender?: string;
  /** SENT on create, never RETURNED — the server encrypts it into its own column (see `hasCnic`). */
  cnic?: string; maritalStatus?: string; nationality?: string; photoUrl?: string;
  whatsapp?: string; currentAddress?: string; permanentAddress?: string; city?: string; province?: string; postalCode?: string;
  preferredSubjects?: string; gradeLevels?: string;
  /** List of qualifications. The flat fields below are legacy (a single, highest one). */
  educations?: TeacherEducation[];
  highestQualification?: string; degreeTitle?: string; majorSubject?: string; university?: string; passingYear?: number; cgpa?: string;
  totalExperience?: string; experiences?: TeacherExperience[];
  /** Free-form skill tags. The five fields below are legacy, kept so older records still read. */
  skills?: string[];
  languages?: string; computerSkills?: string; lmsExperience?: string; msOfficeSkills?: string; classroomManagement?: string;
}
/** HR rollup for the campus staff record — replaces the deleted recruitment summary.
 *  `coverageGaps` derives where the school is short of teachers from the real class
 *  structure, so it cannot go stale the way a hand-posted vacancy board did. */
export interface HrSummary {
  headcount: number;
  joinersThisMonth: number;
  joinersThisYear: number;
  needsSetup: { staffId: string; fullName: string | null; email: string; reason: string }[];
  coverageGaps: { classId: string; className: string; sectionId: string; sectionName: string; subjectId: string; subjectName: string }[];
}

export interface AdmissionsSummary {
  byStatus: Record<string, number>;
  totals: { total: number; open: number; testsScheduled: number; readyToAdmit: number; admitted: number };
  testsToday: number;
  admittedThisMonth: number;
  conversionRate: number;
}


export interface TeacherClass {
  assignmentId: string; sectionId: string; sectionName: string; classId: string | null; className: string;
  academicYearId: string; yearName: string; subjectId: string | null; subjectName: string | null;
  isClassTeacher: boolean; studentCount: number;
}
/** Formative assessment — never a report-card input. `totalMarks` differs per test, so any
 *  rollup normalises to a percentage. */
export interface ClassTest {
  id: string; sectionId: string; subjectId: string; name: string;
  totalMarks: string; testDate: string; createdById: string | null;
  subject?: { name: string };
  section?: { name: string; class?: { id: string; name: string } };
  scoreCount?: number;
}
export interface ClassTestScore {
  id: string; enrollmentId: string; marksObtained: string | null; isAbsent: boolean;
}
export interface ClassTestDetail extends ClassTest { scores: ClassTestScore[] }

/** Portal performance. Note there is deliberately NO class average or rank here — a student
 *  sees their own trend, not their position. Comparison lives on the staff side. */
export interface PerfSummary { percent: number | null; testsTaken: number; testsMissed: number; marksObtained: number; marksTotal: number }
export interface PerfMonth extends PerfSummary { month: string }
export interface PortalSubjectPerf {
  subjectId: string; subjectName: string;
  summary: PerfSummary; monthly: PerfMonth[];
  tests: { id: string; name: string; testDate: string; totalMarks: number; marksObtained: number | null; isAbsent: boolean }[];
}
export interface PortalPerformance { overall: PerfSummary; monthly: PerfMonth[]; subjects: PortalSubjectPerf[] }
export interface PortalAttendanceSummary {
  days: number; percent: number | null;
  counts: Record<string, number>;
  records: { date: string; session: string; status: string }[];
}

export interface RosterRow {
  studentId: string; fullName: string; grNumber: string; registrationNo: string | null;
  rollNumber: number | null; enrollmentId: string;
}
export interface StaffAttendanceRow { date: string; session: string; status: string; checkIn: string | null; checkOut: string | null }
export interface Payslip { id: string; runId: string; gross: string; attendanceDeduction: string; otherDeductions: string; netPay: string; status: string; paidAt: string | null }
/** Admin queue rows carry the person's name so the screen never has to resolve ids itself. */
export interface StaffLeaveRow extends StaffLeave { staffId: string; staff?: { fullName: string | null; employeeCode: string } }
export interface StudentLeaveRow extends StudentLeave { student?: { fullName: string; grNumber: string } }
export interface StaffLeave { id: string; leaveType: string; fromDate: string; toDate: string; reason: string; status: string; isUnpaid: boolean; rejectionReason: string | null; createdAt: string }
export interface StudentLeave { id: string; studentId: string; fromDate: string; toDate: string; reason: string; status: string; rejectionReason: string | null; createdAt: string }

export const api = {
  login: (email: string, password: string) => apiPost<LoginResult>('/auth/login', { email, password }),
  logout: () => apiPost<null>('/auth/logout'),
  me: () => apiGet<Me>('/auth/me'),
  mfa: {
    /** Step 2 of login for an MFA-enabled account — exchanges the pending token for a session. */
    challenge: (mfaToken: string, code: string) =>
      apiPost<{ user: Me; usedRecoveryCode?: boolean; recoveryCodesRemaining?: number }>('/auth/mfa/challenge', { mfaToken, code }),
    /** Starts enrolment: rotates a fresh secret and returns its otpauth:// URI. */
    setup: () => apiPost<{ otpauthUrl: string }>('/auth/mfa/setup'),
    /** Confirms the first code, switches MFA on, and returns the recovery codes ONCE. */
    verify: (code: string) => apiPost<{ recoveryCodes: string[] }>('/auth/mfa/verify', { code }),
    disable: (password: string, code: string) => apiDelete<null>('/auth/mfa', { password, code }),
    /** How many unused codes remain — the only readable fact about them. */
    recoveryStatus: () => apiGet<{ remaining: number }>('/auth/mfa/recovery-codes'),
    /** Issues a fresh set of ten and invalidates the old one. Shown once. */
    regenerateRecovery: () => apiPost<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes'),
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

  /** The per-campus admission seat (§8/§23) — one officer per campus. `set` both assigns and
   *  hands over, in one request, so the seat is never momentarily held by nobody or by two. */
  admissionOfficers: {
    list: () => apiGet<CampusAdmissionOfficer[]>('/admission-officers'),
    set: (campusId: string, userId: string) => apiPut<SetOfficerResult>(`/admission-officers/${campusId}`, { userId }),
    remove: (campusId: string) => apiDelete<{ campusId: string; officer: null }>(`/admission-officers/${campusId}`),
  },
  /** Class-test performance drill-down: campus → class → student (owner / campus admin). */
  performance: {
    byClass: (range: PerformanceRange, campusId?: string) =>
      apiGet<ClassPerformance[]>(`/reports/performance/classes?range=${range}${campusId ? `&campusId=${campusId}` : ''}`),
    byStudent: (classId: string, range: PerformanceRange) =>
      apiGet<ClassStudents>(`/reports/performance/classes/${classId}?range=${range}`),
    forStudent: (studentId: string, range: PerformanceRange) =>
      apiGet<StudentPerformance>(`/reports/performance/students/${studentId}?range=${range}`),
  },
  hr: {
    /** Campus-scoped for an HR manager; school-wide for owner/campus admin. */
    summary: () => apiGet<HrSummary>('/staff/summary'),
  },
  staff: {
    list: () => apiGet<ManagedTeacher[]>('/staff'),
    // `password` (min 10) makes the login usable immediately; omit it and the account stays
    // INVITED until an owner sets one.
    create: (body: { email: string; staffType: string; fullName?: string; employeeCode: string; designation: string; joinedAt: string; campusId?: string; roles?: string[]; password?: string }) =>
      apiPost<{ userId: string; staffId: string; employeeCode: string; email: string; loginActive: boolean }>('/staff', body),
    myAttendance: () => apiGet<StaffAttendanceRow[]>('/staff-attendance/mine'),
  },
  /** Admin approval queue — both kinds of leave, the same two verbs. */
  leaveQueue: {
    students: (status = 'PENDING') => apiGet<{ data: StudentLeaveRow[]; total: number }>(`/student-leaves?status=${status}`),
    staff: (status = 'PENDING') => apiGet<{ data: StaffLeaveRow[]; total: number }>(`/staff-leaves?status=${status}`),
    approveStudent: (id: string) => apiPost<StudentLeave>(`/student-leaves/${id}/approve`, {}),
    rejectStudent: (id: string, reason: string) => apiPost<StudentLeave>(`/student-leaves/${id}/reject`, { reason }),
    approveStaff: (id: string) => apiPost<StaffLeave>(`/staff-leaves/${id}/approve`, {}),
    rejectStaff: (id: string, reason: string) => apiPost<StaffLeave>(`/staff-leaves/${id}/reject`, { reason }),
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
    /** Defaults to the current academic year server-side. */
    list: (q: { sectionId?: string; staffId?: string; academicYearId?: string } = {}) => {
      const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();
      return apiGet<TeacherAssignment[]>(`/teacher-assignments${qs ? `?${qs}` : ''}`);
    },
    create: (body: { staffId: string; academicYearId: string; sectionId: string; subjectId?: string }) =>
      apiPost<TeacherAssignment>('/teacher-assignments', body),
    remove: (id: string) => apiDelete(`/teacher-assignments/${id}`),
  },
  campuses: {
    list: () => apiGet<Campus[]>('/campuses'),
    update: (id: string, body: { name?: string; address?: string }) => apiPatch<Campus>(`/campuses/${id}`, body),
    remove: (id: string) => apiDelete<null>(`/campuses/${id}`),
  },
  classes: {
    rename: (id: string, name: string) => apiPatch<Klass>(`/classes/${id}`, { name }),
    update: (id: string, body: { name?: string; order?: number; minAgeYears?: number; maxAgeYears?: number }) =>
      apiPatch<Klass>(`/classes/${id}`, body),
    remove: (id: string) => apiDelete<null>(`/classes/${id}`),
  },
  sections: {
    create: (body: { classId: string; name: string; capacity?: number; subjectIds?: string[]; copySubjectsFromSectionId?: string }) =>
      apiPost<Section>('/sections', body),
    setSubjects: (id: string, subjectIds: string[]) => apiPut<{ sectionId: string; subjectIds: string[] }>(`/sections/${id}/subjects`, { subjectIds }),
    update: (id: string, body: { name?: string; capacity?: number }) => apiPatch<Section>(`/sections/${id}`, body),
    remove: (id: string) => apiDelete<null>(`/sections/${id}`),
  },
  subjects: {
    list: (classId: string) => apiGet<Subject[]>(`/subjects?classId=${classId}`),
    /** Every subject in scope — one call instead of one per class on the Setup screen. */
    listAll: () => apiGet<Subject[]>('/subjects'),
    catalogue: () => apiGet<SubjectCatalogueEntry[]>('/subjects/catalogue'),
    create: (classId: string, name: string) => apiPost<Subject>('/subjects', { classId, name }),
    rename: (id: string, name: string) => apiPatch<Subject>(`/subjects/${id}`, { name }),
    remove: (id: string) => apiDelete<null>(`/subjects/${id}`),
  },
  terms: {
    remove: (id: string) => apiDelete<{ ok: boolean }>(`/terms/${id}`),
  },
  admissions: {
    summary: () => apiGet<AdmissionsSummary>('/inquiries/summary'),
  },
  students: {
    // Direct admission — ADMISSION_CONTROLLER only. A 422 AGE_OUT_OF_RANGE is retried with ageOverride.
    admit: (body: DirectAdmissionBody) => apiPost<AdmissionResult>('/students', body),
    /** Record or replace the CNIC after admission; provisions the portal login if absent.
     *  Replacing one RETIRES the old number as a sign-in credential. */
    setCnic: (id: string, cnic: string) =>
      apiPatch<{ loginProvisioned: boolean; replacedExisting: boolean; registrationNo: string | null }>(`/students/${id}/cnic`, { cnic }),
    /** Audited: every reveal writes a STUDENT_CNIC_REVEALED row. Owner / campus admin only. */
    revealCnic: (id: string) => apiGet<{ cnic: string }>(`/students/${id}/cnic`),
    // Existing-parent lookup by phone for the guardian match→link step.
    findParents: (phone: string) => apiGet<ParentMatch[]>(`/students/parents/search?phone=${encodeURIComponent(phone)}`),
    // Lifecycle change (suspend / restrict / strike off / restore). Reason is mandatory — it
    // lands in the audit log. Leaving school goes through the withdrawal workflow instead.
    changeStatus: (id: string, body: { status: StudentStatus; reason: string; effectiveFrom?: string; endsOn?: string }) =>
      apiPatch<StudentDetail>(`/students/${id}/status`, body),
    remove: (id: string) => apiDelete<null>(`/students/${id}`),
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
  classTests: {
    list: (sectionId?: string) => apiGet<ClassTest[]>(`/class-tests${sectionId ? `?sectionId=${sectionId}` : ''}`),
    get: (id: string) => apiGet<ClassTestDetail>(`/class-tests/${id}`),
    create: (body: { sectionId: string; subjectId: string; name: string; totalMarks: number; testDate: string }) =>
      apiPost<ClassTest>('/class-tests', body),
    /** Partial-failure, like attendance and exam marks: one bad row never rejects the register. */
    setScores: (id: string, rows: Array<{ enrollmentId: string; marksObtained?: number; isAbsent?: boolean }>) =>
      apiPost<{ saved: number; failed: number; errors: Array<{ index: number; message: string }> }>(`/class-tests/${id}/scores`, { rows }),
    remove: (id: string) => apiDelete<{ deleted: boolean }>(`/class-tests/${id}`),
  },
  studentLeaves: {
    // NO CALLER since the parent portal was removed (2026-07-28). Kept on purpose: the server
    // endpoints still admit OWNER_ADMIN/CAMPUS_ADMIN/TEACHER and the dashboard shows a
    // "Pending leaves" metric, so this is the client for the admin leave screen that does not
    // exist yet. Delete it if that screen is never built.
    list: (studentId: string) => apiGet<{ data: StudentLeave[] }>(`/student-leaves?studentId=${studentId}`),
    apply: (body: { studentId: string; fromDate: string; toDate: string; reason: string }) => apiPost<StudentLeave>('/student-leaves', body),
    cancel: (id: string) => apiPost<StudentLeave>(`/student-leaves/${id}/cancel`, {}),
  },
  portal: {
    overview: () => apiGet<PortalOverview>('/portal/overview'),
    attendance: () => apiGet<PortalAttendance[]>('/portal/attendance'),
    results: () => apiGet<PortalResult[]>('/portal/results'),
    performance: () => apiGet<PortalPerformance>('/portal/performance'),
    attendanceSummary: () => apiGet<PortalAttendanceSummary>('/portal/attendance/summary'),
    fees: () => apiGet<PortalFee[]>('/portal/fees'),
  },
};
