import { Role } from '@prisma/client';

/**
 * Module catalog (blueprint §23 extension). A "module" is a controllable slice of a granted
 * role's functionality. A role grant unlocks all of its modules by default; the owner can
 * switch an individual module off for one user (a `module_access` row with `allowed=false`).
 * This is the single source of truth for what modules exist and which role owns each.
 */
export interface ModuleDef {
  key: string;
  label: string;
  role: Role;
  description: string;
}

export const MODULES: ModuleDef[] = [
  { key: 'recruitment.vacancies', label: 'Vacancies', role: Role.HR_MANAGER, description: 'Post and close job openings' },
  { key: 'recruitment.applications', label: 'Applications', role: Role.HR_MANAGER, description: 'Review, shortlist and reject applicants' },
  { key: 'recruitment.hire', label: 'Hiring', role: Role.HR_MANAGER, description: 'Hire an applicant (creates their staff login)' },

  { key: 'admissions.inquiries', label: 'Inquiries', role: Role.ADMISSION_CONTROLLER, description: 'Create inquiries, schedule and record entry tests' },
  { key: 'admissions.admit', label: 'Admit students', role: Role.ADMISSION_CONTROLLER, description: 'Finalise an admission and enrol the student' },

  { key: 'fees.invoicing', label: 'Invoicing', role: Role.ACCOUNTANT, description: 'Generate fee invoice batches' },
  { key: 'fees.payments', label: 'Payments', role: Role.ACCOUNTANT, description: 'Collect and record fee payments' },
];

const BY_KEY = new Map(MODULES.map((m) => [m.key, m]));

export function isModuleKey(key: string): boolean {
  return BY_KEY.has(key);
}

export function moduleLabel(key: string): string {
  return BY_KEY.get(key)?.label ?? key;
}

/** The modules visible to a set of roles (the union of each role's modules). */
export function modulesForRoles(roles: readonly string[]): ModuleDef[] {
  return MODULES.filter((m) => roles.includes(m.role));
}

/** True if `moduleKey` belongs to a role the user actually holds. */
export function moduleBelongsToRoles(moduleKey: string, roles: readonly string[]): boolean {
  const m = BY_KEY.get(moduleKey);
  return !!m && roles.includes(m.role);
}
