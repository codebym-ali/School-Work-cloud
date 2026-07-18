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

const NON_STUDENT: Role[] = ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT', 'TEACHER', 'PARENT'];

export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', roles: NON_STUDENT },
  { href: '/setup', label: 'Setup', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { href: '/students', label: 'Students', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { href: '/admissions', label: 'Admissions', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { href: '/attendance', label: 'Attendance', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER'] },
  { href: '/fees', label: 'Fees', roles: ['OWNER_ADMIN', 'ACCOUNTANT'] },
  { href: '/exams', label: 'Exams', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER'] },
  { href: '/reports', label: 'Reports', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { href: '/users', label: 'Users', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  // Student self-service portal (§28) — read-only, own data.
  { href: '/me', label: 'My Dashboard', roles: ['STUDENT'] },
  { href: '/me/attendance', label: 'My Attendance', roles: ['STUDENT'] },
  { href: '/me/results', label: 'My Results', roles: ['STUDENT'] },
  { href: '/me/fees', label: 'My Fees', roles: ['STUDENT'] },
];

/** Where a role should land after login. A pure student goes to their portal. */
export function landingPath(roles: string[] | undefined): string {
  const r = roles ?? [];
  if (r.some((x) => (NON_STUDENT as string[]).includes(x))) return '/dashboard';
  if (r.includes('STUDENT')) return '/me';
  return '/dashboard';
}

/** True if the user holds any of the allowed roles (or the item is unrestricted). */
export function hasAnyRole(userRoles: string[] | undefined, allowed?: Role[]): boolean {
  if (!allowed || allowed.length === 0) return true;
  return (userRoles ?? []).some((r) => (allowed as string[]).includes(r));
}

/** The nav entry that owns a pathname, used to gate the routed page. */
export function navItemFor(pathname: string): NavItem | undefined {
  return NAV.find((n) => pathname === n.href || pathname.startsWith(`${n.href}/`));
}
