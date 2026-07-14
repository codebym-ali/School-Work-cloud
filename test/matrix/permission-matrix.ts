/**
 * Permission matrix (blueprint §23, security playbook P1.14) as data. Each row names a
 * representative endpoint per module, the roles RolesGuard must ADMIT, and whether the
 * admitted non-owner roles are additionally scope-gated (campus/ownership) — in which
 * case only OWNER_ADMIN's positive reachability is asserted, while the deny side (every
 * non-admitted role → 403) is always asserted. The conformance spec drives these against
 * the live Nest routes, so a change to any `@Roles` decorator that diverges from this
 * table fails CI (merge-blocking).
 */
export type MatrixRole = 'OWNER_ADMIN' | 'CAMPUS_ADMIN' | 'ACCOUNTANT' | 'TEACHER' | 'PARENT';

export const MATRIX_ROLES: MatrixRole[] = ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT', 'TEACHER', 'PARENT'];

export interface MatrixRow {
  label: string;
  method: 'get' | 'post';
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
  { label: 'create class', method: 'post', path: '/api/v1/classes', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'create academic year', method: 'post', path: '/api/v1/academic-years', body: {}, allow: ['OWNER_ADMIN'] },
  { label: 'list inquiries', method: 'get', path: '/api/v1/inquiries', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'mark attendance', method: 'post', path: '/api/v1/attendance/bulk', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER'], scopeGated: true },
  { label: 'create exam', method: 'post', path: '/api/v1/exams', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'list invoices', method: 'get', path: '/api/v1/fees/invoices', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT'], scopeGated: true },
  { label: 'generate invoice batch', method: 'post', path: '/api/v1/fees/invoice-batches', body: {}, allow: ['OWNER_ADMIN', 'ACCOUNTANT'] },
  { label: 'reverse payment', method: 'post', path: '/api/v1/fees/payments/00000000-0000-0000-0000-000000000000/reversals', body: { reason: 'x' }, allow: ['OWNER_ADMIN'] },
  { label: 'class-strength report', method: 'get', path: '/api/v1/reports/class-strength', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT'], scopeGated: true },
  { label: 'dashboard', method: 'get', path: '/api/v1/dashboard', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT'] },
  { label: 'create staff', method: 'post', path: '/api/v1/staff', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'run payroll', method: 'post', path: '/api/v1/payroll-runs', body: {}, allow: ['OWNER_ADMIN'] },
];
