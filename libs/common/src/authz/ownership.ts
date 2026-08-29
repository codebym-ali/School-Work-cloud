import type { RequestUser } from '../context/tenant-context';

/**
 * Ownership/self-scope helpers (blueprint §22.8, security playbook P1.7).
 *
 * The GuardianOfStudent / Self checks read tenant rows (the guardian link), so — like
 * campus scoping — they run **in services**, not guards (guards execute before the
 * withTenant tx and would see 0 rows under RLS). This module only carries the pure role
 * predicate; each service issues the `studentGuardian` lookup on its own tenant client.
 */

/** OWNER_ADMIN, its deputy OPERATIONS_ADMIN, or CAMPUS_ADMIN — the school/campus-level admin roles
 *  (campus scope applied separately; Ops is school-wide like the owner). */
export function isAdminRole(user: RequestUser | undefined): boolean {
  return !!user && (user.roles.includes('OWNER_ADMIN') || user.roles.includes('OPERATIONS_ADMIN') || user.roles.includes('CAMPUS_ADMIN'));
}
