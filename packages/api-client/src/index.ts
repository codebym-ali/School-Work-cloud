/**
 * API client for the school-management backend. Calls are same-origin (`/api/v1/*`);
 * the browser sends the httpOnly session cookies automatically (credentials: include),
 * and this client attaches the CSRF double-submit header for state-changing requests
 * (reads the non-httpOnly `csrf` cookie, blueprint §22.2).
 */
// ApiError moved to the shared react-free `@sw/http` package (Phase 1) so the SuperAdmin console can
// use it without importing this tenant client. Re-exported so `@/lib/api` consumers are unchanged.
import { ApiError } from '@sw/http';
export { ApiError };

const BASE = '/api/v1';

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
  /** Coverage travels WITH the percentage: 100% off two marked registers is not 100% attendance. */
  todayAttendanceMarked: number | null; todayAttendanceExpected: number | null;
  /** Today's register by what actually happened. Ops data, so `null` for an ACCOUNTANT — the
   *  same gate as the percentage it breaks down. */
  attendanceBreakdown: AttendanceBreakdown | null;
  /** Six months of collections, oldest first. Financial, so every dashboard role gets it. */
  collectionsTrend: CollectionPoint[];
  /** Metric keys this role should see — the UI renders only these cards (role-shaping). */
  visible: string[];
}
/** `unmarked` is not a status: it is the registers nobody has filled in, and it is what stops a
 *  part-to-whole chart implying the whole school has been accounted for. */
export interface AttendanceBreakdown {
  present: number; late: number; leave: number; absent: number; unmarked: number;
}
/** `month` is `YYYY-MM` so it sorts as a string and needs no date parsing to plot. */
export interface CollectionPoint { month: string; collected: number; }
/** A declared school closure. `campusId: null` ⇒ the whole school. */
export interface Holiday {
  id: string; date: string; name: string; campusId: string | null;
  campus?: { name: string } | null;
}
/** Is the school shut today or tomorrow? Drives the banner in the app shell — every role. */
export interface ClosureNotice {
  closure: { date: string; name: string; when: 'TODAY' | 'TOMORROW' } | null;
}
/**
 * "What changed for me" — derived server-side from the records themselves, never stored, so an
 * item vanishes when its cause does. `unread` is counted from THIS list, never fetched separately:
 * a bell reading 3 that opens onto 2 items is worse than no bell.
 */
export interface NotificationItem {
  id: string;
  /** Kept in step with `NotificationsService`'s union. It had drifted — the client still listed
   *  only the four N0 kinds while the server had grown nine more, so every N2 item arrived typed
   *  as something it was not, and a `kind ===` check could not be trusted. */
  kind:
    | 'LEAVE_DECIDED' | 'REGISTER_UNMARKED' | 'MARKED_ABSENT' | 'SALARY_PAID'
    | 'DEFAULTERS' | 'LEAVES_PENDING' | 'SMS_FAILED' | 'CLAIMS_PENDING'
    | 'REGISTERS_UNMARKED' | 'STAFF_UNMARKED' | 'STAFF_ABSENT'
    | 'READY_TO_ADMIT' | 'TESTS_TODAY'
    | 'COVERING_TODAY' | 'COVERED_TODAY';
  severity: 'info' | 'warn';
  text: string;
  href: string;
  at: string;
  isNew: boolean;
}
export interface Notifications { items: NotificationItem[]; unread: number }
/** Registers still unmarked today (G3) — surfaced to the head, never enforced on the teacher. */
export interface UnmarkedRegisters {
  /** False before the school's own mark-by time: the UI stays quiet until the deadline passes. */
  due: boolean;
  markByTime: string;
  count: number;
  /** `coveredBy` names who actually holds the register today — chase the cover, not the teacher
   *  who was away and could not have marked it (Cover Plan §6a). */
  sections: Array<{ sectionId: string; className: string; sectionName: string; expected: number; marked: number; partial: boolean; coveredBy: string | null }>;
}
/**
 * **My own** unmarked registers, named (Teacher App Shell Plan T2) — self-scoped, so any staff
 * member may ask and a non-teacher simply gets an empty list. `due` is false before the school's
 * mark-by time, and the home screen stays quiet until then.
 */
export interface MyUnmarkedRegisters {
  due: boolean;
  markByTime: string;
  /** Registers answerable for today, before filtering to the unmarked — distinguishes "you have
   *  no classes" from "all of yours are done", which otherwise arrive identically as `[]`. */
  responsible: number;
  sections: Array<{ sectionId: string; className: string; sectionName: string; expected: number; marked: number }>;
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

// ── SMS / notifications (§14) ────────────────────────────────────────────────
export interface SmsTemplate { triggerKey: string; body: string }
export interface SmsLog {
  id: string; recipient: string; templateKey: string; message: string;
  segments: number; status: 'QUEUED' | 'SENT' | 'DELIVERED' | 'FAILED';
  failReason: string | null; createdAt: string; sentAt: string | null; deliveredAt: string | null;
}
export interface Campus { id: string; name: string; address?: string | null }
export interface AcademicYear { id: string; name: string; isCurrent: boolean }
export interface CoverageGap {
  classId: string; className: string;
  sectionId: string; sectionName: string;
  subjectId: string; subjectName: string;
}
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
export interface Invoice {
  id: string; studentId: string; totalAmount: string; paidAmount: string; status: string;
  month: number | null; year: number; dueDate: string;
  /** Carried on the row — a fee screen must never resolve a child's name from a paginated list. */
  student?: { fullName: string; grNumber: string };
}
export interface FeeHead { id: string; name: string }
/** One price for one head, for one class, from `effectiveFrom`. Several rows may exist for the
 *  same head — they are a price HISTORY, and invoicing uses whichever is in force for the month
 *  it bills. `isActive: false` rows are returned too: the plan must show what was switched off. */
export interface FeeStructure {
  id: string; campusId: string; classId: string; feeHeadId: string; academicYearId: string;
  amount: string; frequency: string; isActive: boolean; effectiveFrom: string;
}
/** `proofFileKey` is never sent to the browser — presence is signalled by `hasProof`. */
export interface Payment {
  id: string; invoiceId: string; receiptNo: number; amountPaid: string; method: string;
  transactionRef: string | null; paidAt: string;
  /** Presence only — the storage key never leaves the server. */
  hasProof: boolean;
}
/** A claim is NOT a payment: `paymentId` is null until someone verifies it. */
export interface FeeClaim {
  id: string; studentId: string; invoiceId: string;
  amount: string; method: string; transactionRef: string | null;
  paidOn: string; note: string | null;
  status: 'PENDING' | 'VERIFIED' | 'REJECTED';
  source: 'OFFICE' | 'STUDENT_PORTAL' | 'GUARDIAN_LINK';
  rejectionReason: string | null; paymentId: string | null; createdAt: string;
  /** Presence only — the storage key never leaves the server. */
  hasProof: boolean;
  student: { fullName: string; grNumber: string };
  invoice: { month: number | null; year: number; totalAmount: string; paidAmount: string };
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
export interface Subject { id: string; name: string; classId: string; periodsPerWeek: number | null }
export interface SubjectCatalogueClass { subjectId: string; classId: string; className: string; periodsPerWeek: number | null }
export interface SubjectCatalogueEntry {
  name: string;
  classCount: number;
  /** Present from the server (the /subjects screen); absent in the client-derived fallback. */
  classes?: SubjectCatalogueClass[];
  /** Sections teaching a subject of this name with no teacher — reuses the one gap fact (Law 4). */
  sectionGaps?: number;
}
export interface Term { id: string; name: string; academicYearId: string; startDate: string; endDate: string }
export interface GradeBand { label: string; minPercent: string; maxPercent: string; gradePoint: string }
export interface Exam { id: string; termId: string; classId: string; name: string; examType: string; weightagePercent: string; examDate: string; status: string }
export interface ExamResult {
  id: string; examId: string; enrollmentId: string; subjectId: string;
  marksObtained: string | null; totalMarks: string; isAbsent: boolean;
  subject?: { name: string };
  /** Carries the student's name — the results table must not resolve it from a paginated list. */
  enrollment?: { studentId: string; sectionId: string; student?: { fullName: string; grNumber: string } };
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
export interface PortalPayment { id: string; receiptNo: number; amount: number; method: string; paidAt: string; reversed: boolean }
export interface PortalFee {
  id: string; month: number | null; year: number; total: number; paid: number; remaining: number;
  status: string; dueDate: string;
  /** The receipts against this bill. "You owe X" without them is the half-answer. */
  payments: PortalPayment[];
}

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
export interface TimetableSlot {
  id: string; dayOfWeek: number; periodNo: number; room: string | null;
  /** From the section's bell. **Null when the school has not set its timings** — not a zero. */
  startTime: string | null; endTime: string | null;
  subject: { id: string; name: string };
  staff: { id: string; fullName: string | null; employeeCode: string };
  section: { id: string; name: string; class: { id: string; name: string; campusId: string } };
}
export interface SectionTimetable {
  sectionId: string; academicYearId: string;
  section: { id: string; name: string; class: { id: string; name: string; campusId: string } };
  /** The declared day this grid renders. Null ⇒ no timings set, and the shape is inferred instead. */
  bell: BellSchedule | null;
  /** Advisory weekly load per subject. `target: null` ⇒ the school has not allocated one. */
  load: Array<{ subjectId: string; name: string; target: number | null; placed: number }>;
  slots: TimetableSlot[];
}
/** `as` says which week you were given — a teacher's, a student's, or neither. */
export interface MyTimetable {
  as: 'TEACHER' | 'STUDENT' | 'NONE'; academicYearId: string;
  /** Present for a student (one section). A teacher's week can cross wings, so times ride the slots. */
  bell?: BellSchedule | null;
  slots: TimetableSlot[];
}
export interface TimetableCoverage {
  academicYearId: string;
  sections: Array<{ sectionId: string; className: string; sectionName: string; slots: number }>;
}

// ── Bell schedule (the school's own clock) ───────────────────────────────────
/** One row of a composed day. Teaching rows are numbered; breaks carry a label instead. */
export interface BellRow {
  id: string; sequence: number; isTeaching: boolean;
  periodNo: number | null; label: string | null;
  startTime: string; endTime: string;
}
export interface BellDay {
  dayOfWeek: number;
  /** Null on a day nobody has composed — which is a different answer from "no periods". */
  startsAt: string | null; endsAt: string | null;
  teachingPeriods: number;
  rows: BellRow[];
}
export interface BellSchedule {
  id: string; name: string; isDefault: boolean;
  campusId: string; campusName: string; academicYearId: string;
  classes: Array<{ id: string; name: string }>;
  /** Always seven entries, Monday first — an uncomposed day is present and empty. */
  days: BellDay[];
}
/** What the client sends for one day: a start time and a duration per row. Never a time per row. */
export interface BellDayInput {
  startsAt: string;
  rows: Array<{ isTeaching: boolean; label?: string; minutes: number }>;
}
export interface CoverRow {
  id: string; date: string; periodNo: number | null; reason: string | null;
  section: { id: string; name: string; class: { id: string; name: string; campusId: string } };
  coveringStaff: { id: string; fullName: string | null; employeeCode: string };
  absentStaff: { id: string; fullName: string | null; employeeCode: string } | null;
}
/** Who is away on a day, and which of their classes still needs somebody (Cover Plan C1). */
export interface AwayStaff {
  staffId: string; fullName: string | null; employeeCode: string; reason: string;
  sections: Array<{ sectionId: string; className: string; sectionName: string; coveredBy: string | null }>;
}
/** `staffRegisterMarked` false ⇒ the list can only know about approved leave, and says so. */
export interface AwayToday { date: string; staffRegisterMarked: boolean; away: AwayStaff[] }
export interface CoverRangeResult { created: CoverRow[]; skipped: Array<{ date: string; reason: string }> }
/** Cover that touches ME on a day: what I took on, and what of mine somebody else has. */
export interface MyCover { date: string; covering: CoverRow[]; covered: CoverRow[] }
/**
 * Who could take a class, best first (C3). `timetableKnown` false ⇒ nobody is marked FREE, because
 * with no timetable that claim would be an invention — the UI says "in school" and means only that.
 */
export interface CoverSuggestions {
  date: string; periodNo: number | null; timetableKnown: boolean;
  suggestions: Array<{
    staffId: string; fullName: string | null; employeeCode: string;
    status: 'FREE' | 'IN_SCHOOL' | 'BUSY' | 'AWAY'; note: string;
  }>;
}
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
export interface ClassTestDetail extends ClassTest {
  scores: ClassTestScore[];
  /** What the register said on the test date, keyed by enrollmentId. A student with no record
   *  that day is ABSENT FROM THIS MAP — "not marked" is not "was away". */
  attendance: Record<string, string>;
}

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
/** `source` says who recorded it: SELF (the person), ADMIN (the office), SYSTEM (day close). */
export interface StaffAttendanceRow { date: string; session: string; status: string; checkIn: string | null; checkOut: string | null; source: 'SELF' | 'ADMIN' | 'SYSTEM' }
export interface StaffAttendanceSummary {
  from: string; to: string;
  present: number; late: number; halfDay: number; onLeave: number; absent: number;
  marked: number; workingDays: number;
  /** Working days with no record at all — deliberately NOT folded into `absent`. */
  unmarked: number;
  percent: number | null;
}
/** The ways a school can accept money. ADVANCE is excluded — it is the school applying a credit
 *  the guardian already deposited, not a way of paying, so it is never a configurable option. */
export const PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'EASYPAISA', 'JAZZCASH', 'CHEQUE', 'CARD'] as const;
export type PaymentMethodKey = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABEL: Record<PaymentMethodKey, string> = {
  CASH: 'Cash', BANK_TRANSFER: 'Bank transfer', EASYPAISA: 'EasyPaisa',
  JAZZCASH: 'JazzCash', CHEQUE: 'Cheque', CARD: 'Card',
};

export type WeekDay = 'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY' | 'SATURDAY' | 'SUNDAY';
/** Mirrors the Zod schema in `libs/common/config/school-settings.schema.ts`. Keep in step. */
export interface SchoolSettings {
  attendanceSessions: ('MORNING' | 'EVENING')[];
  weeklyOffDays: WeekDay[];
  attendanceEditWindowDays: number;
  attendanceBackfillDays: number;
  allowHolidayOverride: boolean;
  feeDueDay: number;
  midMonthProration: 'FULL' | 'HALF' | 'DAILY';
  siblingDiscountPercent: number;
  sectionCapacityMode: 'HARD' | 'ADVISORY';
  admissionsMode: 'DIRECT' | 'PIPELINE';
  promotionRequiresFeeClearance: boolean;
  smsOverdraftSegments: number;
  staffLeaveQuotas: { CASUAL?: number; SICK?: number; UNPAID?: number; OTHER?: number };
  /** How this school takes money. `methods` is ENFORCED by the API, not merely rendered. */
  feeSubmission: {
    methods: PaymentMethodKey[];
    proofPolicy: 'OFF' | 'OPTIONAL' | 'REQUIRED';
    guardianUploadLink: boolean;
    chequeClearingDays: number;
  };
  timezone: string;
  attendanceMarkByTime: string;
  /** Whether an unexplained absence reduces pay. Unpaid leave is deducted either way. */
  payrollDeductsAbsence: boolean;
  staffAttendance: { selfMarking: boolean; autoMarkAbsent: boolean; dayStartTime: string; graceMinutes: number; closeAtTime: string };
}
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

export interface StaffDaySummary {
  date: string;
  workingDay: boolean;
  holidayName: string | null;
  totalStaff: number;
  present: number; late: number; halfDay: number; onLeave: number; absent: number;
  /** Nobody recorded anything. Never folded into `absent` — see the register. */
  unmarked: number;
  selfMarked: number;
}
/** `status: null` means nobody has said — which is why the register starts from the staff list. */
export interface StaffRegisterRow {
  staffId: string; name: string; employeeCode: string; staffType: string; campus: string | null;
  status: string | null; checkIn: string | null; source: string | null; note: string | null;
}
export interface StaffHistory {
  staff: { id: string; name: string; employeeCode: string; staffType: string; campus: string | null; joinedAt: string };
  from: string; to: string;
  present: number; late: number; onLeave: number; absent: number;
  percent: number | null;
  rows: { id: string; date: string; status: string; checkIn: string | null; source: string; note: string | null }[];
}
export interface CheckInState {
  enabled: boolean;
  nonWorkingDay: boolean;
  today: { status: string; checkIn: string | null; source: string } | null;
  /** What pressing the button would record right now, so "late" is announced, not sprung. */
  wouldBe: 'PRESENT' | 'LATE';
  dayStartTime: string;
  /** When the register is settled, or null where the school doesn't run the day close. */
  closeAtTime: string | null;
  /** The closure's name when today is a declared holiday — so the screen says WHY, not just no. */
  closedFor: string | null;
}
export interface FeeLinkView {
  studentFirstName: string;
  month: number | null;
  year: number;
  dueDate: string;
  outstanding: string;
  settled: boolean;
  methods: string[];
  proofPolicy: 'OFF' | 'OPTIONAL' | 'REQUIRED';
  pendingClaim: { submittedOn: string; amount: string } | null;
}
export interface FeeLinkClaim {
  amount: number;
  method: string;
  transactionRef?: string;
  paidOn: string;
  note?: string;
}
export interface Payslip { id: string; runId: string; gross: string; attendanceDeduction: string; otherDeductions: string; netPay: string; status: string; paidAt: string | null }
/** Admin queue rows carry the person's name so the screen never has to resolve ids itself. */
export interface StaffLeaveRow extends StaffLeave { staffId: string; staff?: { fullName: string | null; employeeCode: string } }
export interface StudentLeaveRow extends StudentLeave { student?: { fullName: string; grNumber: string } }
export interface StaffLeave { id: string; leaveType: string; fromDate: string; toDate: string; reason: string; status: string; isUnpaid: boolean; rejectionReason: string | null; createdAt: string }
export interface StudentLeave { id: string; studentId: string; fromDate: string; toDate: string; reason: string; status: string; rejectionReason: string | null; createdAt: string }
/** `entitlementDays`/`remainingDays` are null when the school has set no quota for that type —
 *  which means "no limit", NOT "none left". Render the two states differently. */
export interface LeaveBalanceRow { leaveType: string; entitlementDays: number | null; usedDays: number; pendingDays: number; remainingDays: number | null }
export interface LeaveBalance {
  staffId: string; windowStart: string; windowEnd: string; balances: LeaveBalanceRow[];
  /** Present only when the caller priced a specific range. Costed by the same server function
   *  that stamps paid/unpaid for real, so the warning cannot drift from the outcome. */
  proposed: { workingDays: number; wouldBeUnpaid: boolean } | null;
}

export const api = {
  login: (email: string, password: string) => apiPost<LoginResult>('/auth/login', { email, password }),
  /**
   * The owner's own door. Refuses everyone else with a response indistinguishable from a wrong
   * password, so it cannot be used to work out which address owns the school.
   */
  ownerLogin: (email: string, password: string) =>
    apiPost<LoginResult>('/auth/owner-login', { email, password }),
  logout: () => apiPost<null>('/auth/logout'),
  me: () => apiGet<Me>('/auth/me'),
  /** Public set-password (SA2): consumes a one-time onboarding / reset token and sets a new
   *  password. No session — the token is the whole authorisation; runs on the tenant's own host. */
  setPassword: (token: string, newPassword: string) => apiPost<null>('/auth/reset-password', { token, newPassword }),
  /** SA5: set the read-only break-glass session cookie from an enter link (public). */
  breakGlassEnter: (token: string) => apiPost<null>('/auth/break-glass-enter', { token }),
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
    /** `qs` from `rangeQuery()` — one definition of "last 3 months" across every view. */
    myAttendance: (qs = '') => apiGet<StaffAttendanceRow[]>(`/staff-attendance/mine${qs ? `?${qs}` : ''}`),
    myAttendanceSummary: (qs = '') => apiGet<StaffAttendanceSummary>(`/staff-attendance/mine/summary${qs ? `?${qs}` : ''}`),
    checkInState: () => apiGet<CheckInState>('/staff-attendance/mine/check-in'),
    /** Which class registers are still unmarked today. Admins only — a teacher gets their own
     *  coverage strip, not a list of which colleagues are behind. */
    unmarkedRegisters: () => apiGet<UnmarkedRegisters>('/attendance/unmarked-today'),
    /** The caller's OWN unmarked registers, named. Self-scoped, so a teacher may ask for theirs. */
    myUnmarkedRegisters: () => apiGet<MyUnmarkedRegisters>('/attendance/mine/unmarked-today'),
    /** Any authenticated role — teachers have no dashboard, so the shell is the only place
     *  a closure notice reaches everybody. */
    closureNotice: () => apiGet<ClosureNotice>('/attendance/closure-notice'),
    checkIn: () => apiPost<{ date: string; status: string; checkIn: string }>('/staff-attendance/check-in', {}),
  },
  notifications: {
    /** Safe for every role: an account with no staff profile gets an empty list, not a 403. */
    list: () => apiGet<Notifications>('/notifications'),
    /** "I have looked." No id anywhere — it can only ever stamp the caller's own account. */
    seen: () => apiPost<{ seenAt: string }>('/notifications/seen', {}),
  },
  /**
   * Private file upload (§22.6): ask for a presigned PUT, send the bytes straight to storage,
   * then confirm so the server can magic-byte check and virus-scan it before promoting it out
   * of quarantine. Returns the storage KEY — never a URL. Reading a file back always goes
   * through the endpoint that owns it, so the ownership check cannot be skipped.
   */
  uploads: {
    async upload(file: File): Promise<{ fileKey: string }> {
      const presign = await apiPost<{ key: string; url: string; maxBytes: number }>('/uploads', {
        filename: file.name, mimeType: file.type,
      });
      if (file.size > presign.maxBytes) {
        throw new ApiError(413, 'TOO_LARGE', `That file is too big — the limit is ${Math.round(presign.maxBytes / 1024 / 1024)} MB.`);
      }
      const put = await fetch(presign.url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
      if (!put.ok) throw new ApiError(put.status, 'UPLOAD_FAILED', 'Could not upload that file. Please try again.');
      return apiPost<{ fileKey: string }>('/uploads/confirm', { key: presign.key, mimeType: file.type });
    },
  },
  /**
   * The guardian fee link — a PUBLIC surface. No session, no CSRF (the API marks it `@Public`),
   * and the token in the path is the entire authorisation. Everything here is reachable by
   * whoever holds the link, so nothing may be added to these responses that the school would
   * not print on a challan.
   */
  feeLink: {
    view: (token: string) => apiGet<FeeLinkView>(`/public/fee-link/${token}`),
    /**
     * Upload → PUT → submit. The QUARANTINE key goes back with the claim, and the server
     * promotes it (magic bytes + virus scan) as part of accepting the submission, so a claim can
     * never reference a file that was not scanned.
     */
    async submit(token: string, body: FeeLinkClaim, file: File | null) {
      let proofFileKey: string | undefined;
      let proofMimeType: string | undefined;
      if (file) {
        const presign = await apiPost<{ key: string; url: string; maxBytes: number }>(
          `/public/fee-link/${token}/upload`, { filename: file.name, mimeType: file.type },
        );
        if (file.size > presign.maxBytes) {
          throw new ApiError(413, 'TOO_LARGE', `That file is too big — the limit is ${Math.round(presign.maxBytes / 1024 / 1024)} MB.`);
        }
        const put = await fetch(presign.url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
        if (!put.ok) throw new ApiError(put.status, 'UPLOAD_FAILED', 'Could not upload that photo. Please try again.');
        proofFileKey = presign.key;
        proofMimeType = file.type;
      }
      return apiPost<{ id: string; status: string }>(`/public/fee-link/${token}/claim`, { ...body, proofFileKey, proofMimeType });
    },
  },
  /**
   * The school calendar — closures (H0/H1).
   *
   * Separate from `schoolSettings.weeklyOffDays`, which is a recurring rule. These are dated
   * records: Eid, 14 August, "we are shut tomorrow".
   */
  holidays: {
    list: (from?: string, to?: string) => {
      const qs = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();
      return apiGet<Holiday[]>(`/holidays${qs ? `?${qs}` : ''}`);
    },
    create: (body: { date: string; name: string; campusId?: string }) => apiPost<Holiday>('/holidays', body),
    createRange: (body: { fromDate: string; toDate: string; name: string; campusId?: string }) =>
      apiPost<{ created: number; skipped: string[]; dates: string[] }>('/holidays/range', body),
    remove: (id: string) => apiDelete<null>(`/holidays/${id}`),
  },
  /** The school's own operating rules. Read by admins, changed only by the owner. */
  /**
   * Enrolment — a student's place in a class, and moving it (Student Transfer Plan, X1).
   *
   * A transfer is not an edit: the API closes the current enrolment and opens a new one, so
   * attendance and marks already recorded stay with the class they happened in.
   */
  enrollments: {
    list: (qs: string) => apiGet<Paged<Enrollment>>(`/enrollments?${qs}`),
    /** Owner / campus admin. Campus-scoped on BOTH ends in the service, and capacity-checked. */
    transfer: (studentId: string, toSectionId: string) =>
      apiPost<Enrollment>('/enrollments/transfer', { studentId, toSectionId }),
  },
  schoolSettings: {
    get: () => apiGet<SchoolSettings>('/school-settings'),
    /** Partial — send only what changed; the server merges, including one level into groups. */
    update: (patch: DeepPartial<SchoolSettings>) => apiPatch<SchoolSettings>('/school-settings', patch),
  },
  /** Oversight: owner / campus admin / HR read the register; only admins mark it. */
  staffAttendance: {
    daySummary: (date?: string, campusId?: string) => {
      const qs = new URLSearchParams({ ...(date ? { date } : {}), ...(campusId ? { campusId } : {}) }).toString();
      return apiGet<StaffDaySummary>(`/staff-attendance/summary${qs ? `?${qs}` : ''}`);
    },
    register: (q: { date?: string; status?: string; campusId?: string } = {}) => {
      const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();
      return apiGet<StaffRegisterRow[]>(`/staff-attendance${qs ? `?${qs}` : ''}`);
    },
    history: (staffId: string, qs = '') =>
      apiGet<StaffHistory>(`/staff-attendance/staff/${staffId}${qs ? `?${qs}` : ''}`),
    mark: (body: { date: string; session: string; records: { staffId: string; status: string }[]; note?: string; allowHolidayOverride?: boolean }) =>
      apiPost<{ succeeded: number; failed: number; errors: { index: number; message: string }[] }>('/staff-attendance/bulk', body),
  },
  /** Admin approval queue — both kinds of leave, the same two verbs. */
  leaveQueue: {
    students: (status = 'PENDING') => apiGet<{ data: StudentLeaveRow[]; total: number }>(`/student-leaves?status=${status}`),
    staff: (status = 'PENDING') => apiGet<{ data: StaffLeaveRow[]; total: number }>(`/staff-leaves?status=${status}`),
    approveStudent: (id: string) => apiPost<StudentLeave>(`/student-leaves/${id}/approve`, {}),
    rejectStudent: (id: string, reason: string) => apiPost<StudentLeave>(`/student-leaves/${id}/reject`, { reason }),
    // Returns how many ABSENT rows the approval corrected, so the office can be told the register
    // was put right rather than having to go and look.
    approveStaff: (id: string) => apiPost<StaffLeave & { attendanceCorrected: number }>(`/staff-leaves/${id}/approve`, {}),
    rejectStaff: (id: string, reason: string) => apiPost<StaffLeave>(`/staff-leaves/${id}/reject`, { reason }),
    /** Whoever is deciding needs the applicant's entitlement, not just their dates — and priced
     *  over THIS request's range, so "approve" is a decision about a known number of paid days. */
    staffBalance: (staffId: string, l: { leaveType: string; fromDate: string; toDate: string }) =>
      apiGet<LeaveBalance>(`/staff-leaves/balance?staffId=${staffId}&leaveType=${l.leaveType}&fromDate=${l.fromDate.slice(0, 10)}&toDate=${l.toDate.slice(0, 10)}`),
  },
  staffLeaves: {
    // Self-scoped on the server for non-admins → the caller's own leaves only.
    mine: () => apiGet<{ data: StaffLeave[]; total: number }>('/staff-leaves'),
    apply: (body: { leaveType: string; fromDate: string; toDate: string; reason: string }) => apiPost<StaffLeave>('/staff-leaves', body),
    cancel: (id: string) => apiPost<StaffLeave>(`/staff-leaves/${id}/cancel`, {}),
    /** No staffId → the server resolves the caller's own profile. Passing a range asks what it
     *  would cost, priced by the server rather than by a copy of the calendar in the browser. */
    balance: (proposed?: { leaveType: string; fromDate: string; toDate: string }) =>
      apiGet<LeaveBalance>(`/staff-leaves/balance${proposed ? `?leaveType=${proposed.leaveType}&fromDate=${proposed.fromDate}&toDate=${proposed.toDate}` : ''}`),
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
    /** Section-subjects with no teacher this year — the SAME server fact /staff reads (audit Law 4). */
    coverage: () => apiGet<CoverageGap[]>('/classes/coverage'),
  },
  sections: {
    create: (body: { classId: string; name: string; capacity?: number; subjectIds?: string[]; copySubjectsFromSectionId?: string }) =>
      apiPost<Section>('/sections', body),
    setSubjects: (id: string, subjectIds: string[]) => apiPut<{ sectionId: string; subjectIds: string[] }>(`/sections/${id}/subjects`, { subjectIds }),
    update: (id: string, body: { name?: string; capacity?: number }) => apiPatch<Section>(`/sections/${id}`, body),
    remove: (id: string) => apiDelete<null>(`/sections/${id}`),
  },
  /**
   * The weekly grid (§23). `timetable_slots` existed from the first schema with no endpoint at
   * all — this is its first client.
   */
  timetable: {
    /** The caller's own week: a teacher's periods or a student's. No id — the server resolves it. */
    mine: () => apiGet<MyTimetable>('/timetable/mine'),
    forSection: (sectionId: string) => apiGet<SectionTimetable>(`/timetable/section/${sectionId}`),
    /** Which sections have no timetable yet — "not built" is a different problem from "empty". */
    coverage: () => apiGet<TimetableCoverage>('/timetable/coverage'),
    /** Create-or-replace one cell. Clash detection is the server's; the UI shows what it says. */
    setSlot: (body: { sectionId: string; dayOfWeek: number; periodNo: number; subjectId: string; staffId: string; room?: string }) =>
      apiPost<TimetableSlot>('/timetable/slots', body),
    clearSlot: (id: string) => apiDelete<{ deleted: boolean }>(`/timetable/slots/${id}`),
    /**
     * Copy one day's lessons onto others. A partial copy is the normal outcome on a half-built
     * week, so `skipped` carries a reason per cell rather than a count.
     */
    copyDay: (body: { sectionId: string; fromDay: number; toDays: number[] }) =>
      apiPost<{ created: number; skipped: Array<{ dayOfWeek: number; periodNo: number; reason: string }> }>(
        '/timetable/copy-day', body),
  },
  /**
   * The school's timings — which periods exist, when they ring, and where the breaks fall.
   *
   * ⚠️ `setDay` sends **durations, not times**. The server walks the day from `startsAt`, so a gap
   * or an overlap between rows is not rejected — there is no field in which to express one.
   */
  sms: {
    templates: () => apiGet<SmsTemplate[]>('/sms/templates'),
    saveTemplate: (triggerKey: string, body: string) => apiPut<SmsTemplate>('/sms/templates', { triggerKey, body }),
    credits: () => apiGet<{ balance: number }>('/sms/credits'),
    logs: (q: { status?: string; templateKey?: string; page?: number } = {}) => {
      const qs = new URLSearchParams();
      if (q.status) qs.set('status', q.status);
      if (q.templateKey) qs.set('templateKey', q.templateKey);
      if (q.page) qs.set('page', String(q.page));
      const s = qs.toString();
      return apiGet<Paged<SmsLog>>(`/sms/logs${s ? `?${s}` : ''}`);
    },
    retry: (id: string) => apiPost<void>(`/sms/logs/${id}/retry`, {}),
  },
  bellSchedules: {
    list: () => apiGet<{ academicYearId: string; schedules: BellSchedule[] }>('/bell-schedules'),
    get: (id: string) => apiGet<BellSchedule>(`/bell-schedules/${id}`),
    create: (body: { campusId: string; name: string; isDefault?: boolean; classIds?: string[] }) =>
      apiPost<BellSchedule>('/bell-schedules', body),
    update: (id: string, body: { name?: string; classIds?: string[] }) =>
      apiPatch<BellSchedule>(`/bell-schedules/${id}`, body),
    remove: (id: string) => apiDelete<{ deleted: boolean }>(`/bell-schedules/${id}`),
    /** `retainedLessons` counts lessons left sitting on periods the shortened day no longer has. */
    setDay: (id: string, dayOfWeek: number, body: BellDayInput) =>
      apiPut<BellSchedule & { retainedLessons: number }>(`/bell-schedules/${id}/days/${dayOfWeek}`, body),
  },
  /**
   * Cover — who is taking a class when its teacher is away.
   *
   * Recording it is what lets the substitute mark the register; without it they are refused with
   * "You are not assigned to this section". Needs no timetable and no staff attendance.
   */
  cover: {
    list: (date: string) => apiGet<{ date: string; cover: CoverRow[] }>(`/cover?date=${date}`),
    create: (body: { sectionId: string; date: string; coveringStaffId: string; periodNo?: number; absentStaffId?: string; reason?: string }) =>
      apiPost<CoverRow>('/cover', body),
    remove: (id: string) => apiDelete<{ deleted: boolean }>(`/cover/${id}`),
    away: (date: string) => apiGet<AwayToday>(`/cover/away?date=${date}`),
    /** What I am covering, and what of mine is covered — self-scoped, so any staff member may ask. */
    mine: (date?: string) => apiGet<MyCover>(`/cover/mine${date ? `?date=${date}` : ''}`),
    suggestions: (sectionId: string, date: string, periodNo?: number) =>
      apiGet<CoverSuggestions>(`/cover/suggestions?sectionId=${sectionId}&date=${date}${periodNo ? `&periodNo=${periodNo}` : ''}`),
    range: (body: { sectionId: string; fromDate: string; toDate: string; coveringStaffId: string; periodNo?: number; absentStaffId?: string; reason?: string }) =>
      apiPost<CoverRangeResult>('/cover/range', body),
  },
  subjects: {
    list: (classId: string) => apiGet<Subject[]>(`/subjects?classId=${classId}`),
    /** Every subject in scope — one call instead of one per class on the Setup screen. */
    listAll: () => apiGet<Subject[]>('/subjects'),
    catalogue: () => apiGet<SubjectCatalogueEntry[]>('/subjects/catalogue'),
    create: (classId: string, name: string, periodsPerWeek?: number) =>
      apiPost<Subject>('/subjects', { classId, name, periodsPerWeek }),
    rename: (id: string, name: string) => apiPatch<Subject>(`/subjects/${id}`, { name }),
    /** Weekly load. `null` clears it — "not allocated" is a real state, distinct from zero. */
    setLoad: (id: string, periodsPerWeek: number | null) =>
      apiPatch<Subject>(`/subjects/${id}`, { periodsPerWeek }),
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
    /** The name appears on every invoice line, so a typo is worth correcting. */
    renameHead: (id: string, name: string) => apiPatch<FeeHead>(`/fee-heads/${id}`, { name }),
    /** Refused while any class price, invoice line or discount still references it. */
    deleteHead: (id: string) => apiDelete<null>(`/fee-heads/${id}`),
    structures: (classId?: string) => apiGet<FeeStructure[]>(`/fee-structures${classId ? `?classId=${classId}` : ''}`),
    createStructure: (body: { classId: string; feeHeadId: string; academicYearId: string; amount: number; frequency: string; effectiveFrom?: string }) =>
      apiPost<FeeStructure>('/fee-structures', body),
    /** Amount is editable only while nothing has been billed from the row; the server 409s
     *  otherwise and names the alternative. `isActive` can always be toggled. */
    updateStructure: (id: string, body: { amount?: number; isActive?: boolean }) =>
      apiPatch<FeeStructure>(`/fee-structures/${id}`, body),
    deleteStructure: (id: string) => apiDelete<null>(`/fee-structures/${id}`),
    copyPlan: (body: { fromClassId: string; fromAcademicYearId: string; toClassIds: string[]; toAcademicYearId?: string; raisePercent?: number; effectiveFrom?: string }) =>
      apiPost<{ created: number; skipped: number; details: string[] }>('/fee-structures/copy', body),
    lateFeePolicy: () => apiGet<LateFeePolicy | null>('/late-fee-policy'),
    /** Payment submissions — money somebody says arrived, pending a human check. */
    claims: (q: { status?: string; studentId?: string } = {}) => {
      const qs = new URLSearchParams({ ...(q.status ? { status: q.status } : {}), ...(q.studentId ? { studentId: q.studentId } : {}), pageSize: '100' }).toString();
      return apiGet<Paged<FeeClaim>>(`/fees/claims?${qs}`);
    },
    pendingClaims: () => apiGet<{ pending: number }>('/fees/claims/pending-count'),
    submitClaim: (body: { invoiceId: string; amount: number; method: string; transactionRef?: string; paidOn: string; proofFileKey?: string; note?: string; autoVerify?: boolean }) =>
      apiPost<FeeClaim & { receiptNo?: number }>('/fees/claims', body),
    verifyClaim: (id: string) => apiPost<FeeClaim & { receiptNo: number }>(`/fees/claims/${id}/verify`, {}),
    rejectClaim: (id: string, reason: string) => apiPost<FeeClaim>(`/fees/claims/${id}/reject`, { reason }),
    claimProof: (id: string) => apiGet<{ url: string }>(`/fees/claims/${id}/proof`),
    /** Short-lived signed link to the proof attached to a payment. */
    paymentProof: (paymentId: string) =>
      apiGet<{ url: string; expiresInSeconds: number }>(`/fees/payments/${paymentId}/proof`),
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
  // `studentLeaves` was removed 2026-08-07. It was kept after the parent portal went (2026-07-28)
  // on the explicit condition "delete it if the admin leave screen is never built" — that screen
  // was built, and it reads `leaveQueue` above, so the condition resolved the other way.
  portal: {
    overview: () => apiGet<PortalOverview>('/portal/overview'),
    attendance: () => apiGet<PortalAttendance[]>('/portal/attendance'),
    results: () => apiGet<PortalResult[]>('/portal/results'),
    performance: () => apiGet<PortalPerformance>('/portal/performance'),
    attendanceSummary: () => apiGet<PortalAttendanceSummary>('/portal/attendance/summary'),
    fees: () => apiGet<PortalFee[]>('/portal/fees'),
    /** A short-lived presigned link to the student's OWN receipt; the server checks ownership. */
    receipt: (paymentId: string) => apiGet<{ url: string }>(`/portal/fees/payments/${paymentId}/receipt`),
  },
};
