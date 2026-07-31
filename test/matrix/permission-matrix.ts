/**
 * Permission matrix (blueprint §23, security playbook P1.14) as data. Each row names a
 * representative endpoint per module, the roles RolesGuard must ADMIT, and whether the
 * admitted non-owner roles are additionally scope-gated (campus/ownership) — in which
 * case only OWNER_ADMIN's positive reachability is asserted, while the deny side (every
 * non-admitted role → 403) is always asserted. The conformance spec drives these against
 * the live Nest routes, so a change to any `@Roles` decorator that diverges from this
 * table fails CI (merge-blocking).
 */
export type MatrixRole = 'OWNER_ADMIN' | 'CAMPUS_ADMIN' | 'ADMISSION_CONTROLLER' | 'ACCOUNTANT' | 'TEACHER' | 'PARENT';

// PARENT is retained even though its portal was removed (2026-07-28): the role still exists,
// and every row's deny-side asserts a PARENT-bearing session reaches NOTHING. That is a
// regression guard worth keeping until the role itself is retired (scope B).
export const MATRIX_ROLES: MatrixRole[] = ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER', 'ACCOUNTANT', 'TEACHER', 'PARENT'];

export interface MatrixRow {
  label: string;
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  body?: Record<string, unknown>;
  /** Roles RolesGuard admits. Every other role must get 403. */
  allow: MatrixRole[];
  /** Admitted non-owner roles may still be scope-403'd (campus/ownership) → skip their positive check. */
  scopeGated?: boolean;
}

export const PERMISSION_MATRIX: MatrixRow[] = [
  { label: 'list students', method: 'get', path: '/api/v1/students', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER'], scopeGated: true },
  // Creating a student is admission-controller-only (segregation of duties); owner/campus are read-only here.
  { label: 'create student', method: 'post', path: '/api/v1/students', body: {}, allow: ['ADMISSION_CONTROLLER'] },
  { label: 'import students (CSV)', method: 'post', path: '/api/v1/students/import', body: {}, allow: ['ADMISSION_CONTROLLER'] },
  { label: 'change student status', method: 'patch', path: '/api/v1/students/00000000-0000-0000-0000-000000000000/status', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  // Deleting a student record is owner-only — it is for mis-keyed admissions, not departures.
  { label: 'delete student', method: 'delete', path: '/api/v1/students/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN'] },
  // Reading a child's national ID is admin-only — notably NOT the admission officer, who
  // captures the CNIC but has no reason to read it back afterwards.
  { label: 'reveal student cnic', method: 'get', path: '/api/v1/students/00000000-0000-0000-0000-000000000000/cnic', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  // ADD includes the admission officer — the guardian is optional at admission, so they must
  // be able to complete the record they created. Edit/remove stay admin-only (below).
  { label: 'add student guardian', method: 'post', path: '/api/v1/students/00000000-0000-0000-0000-000000000000/guardians', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER'] },
  { label: 'admit student', method: 'post', path: '/api/v1/admissions', body: {}, allow: ['ADMISSION_CONTROLLER'] },
  { label: 'request guardian OTP', method: 'post', path: '/api/v1/students/guardians/00000000-0000-0000-0000-000000000000/verify-phone', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { label: 'confirm guardian OTP', method: 'post', path: '/api/v1/students/guardians/00000000-0000-0000-0000-000000000000/verify-phone/confirm', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { label: 'create campus', method: 'post', path: '/api/v1/campuses', body: { name: 'Zeta' }, allow: ['OWNER_ADMIN'] },
  { label: 'delete campus', method: 'delete', path: '/api/v1/campuses/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN'] },
  { label: 'create class', method: 'post', path: '/api/v1/classes', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'rename class', method: 'patch', path: '/api/v1/classes/00000000-0000-0000-0000-000000000000', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'delete class', method: 'delete', path: '/api/v1/classes/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'rename section', method: 'patch', path: '/api/v1/sections/00000000-0000-0000-0000-000000000000', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'delete section', method: 'delete', path: '/api/v1/sections/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'set section subjects', method: 'put', path: '/api/v1/sections/00000000-0000-0000-0000-000000000000/subjects', body: { subjectIds: [] }, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'rename subject', method: 'patch', path: '/api/v1/subjects/00000000-0000-0000-0000-000000000000', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'delete subject', method: 'delete', path: '/api/v1/subjects/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'create academic year', method: 'post', path: '/api/v1/academic-years', body: {}, allow: ['OWNER_ADMIN'] },
  { label: 'list inquiries', method: 'get', path: '/api/v1/inquiries', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER'], scopeGated: true },
  { label: 'admissions summary', method: 'get', path: '/api/v1/inquiries/summary', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER'] },
  { label: 'mark attendance', method: 'post', path: '/api/v1/attendance/bulk', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER'], scopeGated: true },
  { label: 'create exam', method: 'post', path: '/api/v1/exams', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'delete term', method: 'delete', path: '/api/v1/terms/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN'], scopeGated: true },
  { label: 'list invoices', method: 'get', path: '/api/v1/fees/invoices', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT'], scopeGated: true },
  { label: 'generate invoice batch', method: 'post', path: '/api/v1/fees/invoice-batches', body: {}, allow: ['OWNER_ADMIN', 'ACCOUNTANT'] },
  { label: 'reverse payment', method: 'post', path: '/api/v1/fees/payments/00000000-0000-0000-0000-000000000000/reversals', body: { reason: 'x' }, allow: ['OWNER_ADMIN'] },
  { label: 'class-strength report', method: 'get', path: '/api/v1/reports/class-strength', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT'], scopeGated: true },
  { label: 'dashboard', method: 'get', path: '/api/v1/dashboard', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT'] },
  // STUDENT-only. STUDENT isn't one of the seeded matrix roles, so allow:[] asserts every
  // seeded admin/staff role is denied (the STUDENT positive path is in student-portal.e2e).
  { label: 'student portal', method: 'get', path: '/api/v1/portal/overview', allow: [] },
  // Users & roles: create/list is admin; a campus admin is scoped + limited in-service.
  { label: 'list users', method: 'get', path: '/api/v1/users', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { label: 'create user', method: 'post', path: '/api/v1/users', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { label: 'set user access', method: 'patch', path: '/api/v1/users/00000000-0000-0000-0000-000000000000/access', body: { role: 'HR_MANAGER', grant: true }, allow: ['OWNER_ADMIN'] },
  // The per-campus admission seat (§8/§23): the overview is readable by both admins, but only
  // the owner may move it — it decides who speaks for a campus's admissions.
  { label: 'list admission officers', method: 'get', path: '/api/v1/admission-officers', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { label: 'set admission officer', method: 'put', path: '/api/v1/admission-officers/00000000-0000-0000-0000-000000000000', body: { userId: '00000000-0000-0000-0000-000000000000' }, allow: ['OWNER_ADMIN'], scopeGated: true },
  { label: 'remove admission officer', method: 'delete', path: '/api/v1/admission-officers/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN'], scopeGated: true },
  { label: 'list user modules', method: 'get', path: '/api/v1/users/00000000-0000-0000-0000-000000000000/modules', allow: ['OWNER_ADMIN'], scopeGated: true },
  { label: 'set user module', method: 'patch', path: '/api/v1/users/00000000-0000-0000-0000-000000000000/modules', body: { moduleKey: 'recruitment.hire', allowed: false }, allow: ['OWNER_ADMIN'], scopeGated: true },
  { label: 'create staff', method: 'post', path: '/api/v1/staff', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'post vacancy', method: 'post', path: '/api/v1/vacancies', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'add teacher application', method: 'post', path: '/api/v1/teacher-applications', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'update application status', method: 'patch', path: '/api/v1/teacher-applications/00000000-0000-0000-0000-000000000000/status', body: { status: 'SHORTLISTED' }, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'hire applicant', method: 'post', path: '/api/v1/teacher-applications/00000000-0000-0000-0000-000000000000/hire', body: { employeeCode: 'X' }, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'recruitment summary', method: 'get', path: '/api/v1/vacancies/summary', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { label: 'run payroll', method: 'post', path: '/api/v1/payroll-runs', body: {}, allow: ['OWNER_ADMIN'] },

  // Teacher self-service — TEACHER-only; positive path needs a linked StaffProfile so it's
  // scope-gated (deny side is the guarantee here).
  { label: 'teacher my-classes', method: 'get', path: '/api/v1/teaching/my-classes', allow: ['TEACHER'], scopeGated: true },
];
