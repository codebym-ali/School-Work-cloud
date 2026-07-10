/**
 * Role-based navigation + access (mirrors the backend `@Roles` guards, blueprint §18).
 * The API is the source of truth (returns 403); this only shapes the UI so users don't
 * see screens they can't use. `roles: undefined` ⇒ any authenticated user.
 */
export type Role =
  | 'PLATFORM_ADMIN'
  | 'OWNER_ADMIN'
  | 'CAMPUS_ADMIN'
  | 'ACCOUNTANT'
  | 'TEACHER'
  | 'STAFF'
  | 'PARENT'
  | 'STUDENT';

export interface NavItem {
  href: string;
  label: string;
  roles?: Role[];
}

export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/setup', label: 'Setup', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { href: '/students', label: 'Students', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { href: '/admissions', label: 'Admissions', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { href: '/attendance', label: 'Attendance', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER'] },
  { href: '/fees', label: 'Fees', roles: ['OWNER_ADMIN', 'ACCOUNTANT'] },
  { href: '/exams', label: 'Exams', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER'] },
  { href: '/reports', label: 'Reports', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
];

/** True if the user holds any of the allowed roles (or the item is unrestricted). */
export function hasAnyRole(userRoles: string[] | undefined, allowed?: Role[]): boolean {
  if (!allowed || allowed.length === 0) return true;
  return (userRoles ?? []).some((r) => (allowed as string[]).includes(r));
}

/** The nav entry that owns a pathname, used to gate the routed page. */
export function navItemFor(pathname: string): NavItem | undefined {
  return NAV.find((n) => pathname === n.href || pathname.startsWith(`${n.href}/`));
}
