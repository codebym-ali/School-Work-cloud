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

export const MATRIX_ROLES: MatrixRole[] = ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER', 'ACCOUNTANT', 'TEACHER', 'PARENT'];

export interface MatrixRow {
  label: string;
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  body?: Record<string, unknown>;
  /** Roles RolesGuard admits. Every other role must get 403. */
  allow: MatrixRole[];
  /** Admitted non-owner roles may still be scope-403'd (campus/ownership) → skip their positive check. */
  scopeGated?: boolean;
}

export const PERMISSION_MATRIX: MatrixRow[] = [
  { label: 'list students', method: 'get', path: '/api/v1/students', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'import students (CSV)', method: 'post', path: '/api/v1/students/import', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { label: 'request guardian OTP', method: 'post', path: '/api/v1/students/guardians/00000000-0000-0000-0000-000000000000/verify-phone', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { label: 'confirm guardian OTP', method: 'post', path: '/api/v1/students/guardians/00000000-0000-0000-0000-000000000000/verify-phone/confirm', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { label: 'create campus', method: 'post', path: '/api/v1/campuses', body: { name: 'Zeta' }, allow: ['OWNER_ADMIN'] },
  { label: 'delete campus', method: 'delete', path: '/api/v1/campuses/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN'] },
  { label: 'create class', method: 'post', path: '/api/v1/classes', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
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
  // Parent self-service — PARENT-only; returns the caller's children (empty for the seeded
  // parent), so the positive path is asserted directly.
  { label: 'parent children', method: 'get', path: '/api/v1/parent/children', allow: ['PARENT'] },
];
