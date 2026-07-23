/**
 * Role-based navigation + access (mirrors the backend `@Roles` guards, blueprint §18).
 * The API is the source of truth (returns 403); this only shapes the UI so users don't
 * see screens they can't use. `roles: undefined` ⇒ any authenticated user.
 */
export type Role =
  | 'PLATFORM_ADMIN'
  | 'OWNER_ADMIN'
  | 'CAMPUS_ADMIN'
  | 'ADMISSION_CONTROLLER'
  | 'HR_MANAGER'
  | 'ACCOUNTANT'
  | 'TEACHER'
  | 'STAFF'
  | 'PARENT'
  | 'STUDENT';

/**
 * Sidebar groups, in the order they render. Follows the school lifecycle
 * (enrol → teach & assess → bill) with the people/admin config last. A group
 * only appears when the signed-in role has at least one item inside it.
 */
export type NavGroup =
  | 'Overview'
  | 'Enrollment'
  | 'Academics'
  | 'Finance'
  | 'People'
  | 'Administration'
  | 'My Portal';

export const NAV_GROUPS: NavGroup[] = [
  'Overview',
  'Enrollment',
  'Academics',
  'Finance',
  'People',
  'Administration',
  'My Portal',
];

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  group: NavGroup;
  roles?: Role[];
}

export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: '📊', group: 'Overview', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT'] },

  { href: '/admissions', label: 'Admissions', icon: '📝', group: 'Enrollment', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER'] },
  { href: '/admissions-team', label: 'Admission Portal', icon: '🎓', group: 'Enrollment', roles: ['CAMPUS_ADMIN'] },
  { href: '/students', label: 'Students', icon: '👥', group: 'Enrollment', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },

  { href: '/attendance', label: 'Attendance', icon: '✅', group: 'Academics', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER'] },
  { href: '/my-classes', label: 'My Classes', icon: '📚', group: 'Academics', roles: ['TEACHER'] },
  { href: '/exams', label: 'Exams & Results', icon: '📄', group: 'Academics', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER'] },
  { href: '/reports', label: 'Reports', icon: '📈', group: 'Academics', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT'] },

  { href: '/fees', label: 'Fees', icon: '💳', group: 'Finance', roles: ['OWNER_ADMIN', 'ACCOUNTANT'] },

  { href: '/teachers', label: 'Teachers', icon: '🧑‍🏫', group: 'People', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'HR_MANAGER'] },
  { href: '/staff', label: 'Staff', icon: '🧑‍💼', group: 'People', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { href: '/recruitment', label: 'Recruitment', icon: '📋', group: 'People', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'HR_MANAGER'] },

  { href: '/setup', label: 'Setup', icon: '⚙️', group: 'Administration', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { href: '/campuses', label: 'Campus Hub', icon: '🏢', group: 'Administration', roles: ['OWNER_ADMIN'] },

  { href: '/me', label: 'My Dashboard', icon: '🏠', group: 'My Portal', roles: ['STUDENT'] },
  { href: '/me/attendance', label: 'My Attendance', icon: '✅', group: 'My Portal', roles: ['STUDENT'] },
  { href: '/me/results', label: 'My Results', icon: '📄', group: 'My Portal', roles: ['STUDENT'] },
  { href: '/me/fees', label: 'My Fees', icon: '💳', group: 'My Portal', roles: ['STUDENT'] },

  { href: '/parent', label: 'My Children', icon: '👨‍👩‍👧', group: 'My Portal', roles: ['PARENT'] },

  { href: '/my-attendance', label: 'My Attendance', icon: '✅', group: 'My Portal', roles: ['STAFF'] },
  { href: '/my-payslips', label: 'My Payslips', icon: '💵', group: 'My Portal', roles: ['STAFF', 'TEACHER'] },
];

/**
 * Human label for the panel/brand, derived from the signed-in user's roles.
 * Ordered most- to least-privileged so a multi-role user gets their highest panel.
 */
const PANEL_LABELS: [Role, string][] = [
  ['PLATFORM_ADMIN', 'Platform Admin'],
  ['OWNER_ADMIN', 'School Admin'],
  ['CAMPUS_ADMIN', 'Campus Admin'],
  ['ADMISSION_CONTROLLER', 'Admission Portal'],
  ['ACCOUNTANT', 'Accountant'],
  ['TEACHER', 'Teacher'],
  ['HR_MANAGER', 'HR Manager'],
  ['STAFF', 'Staff'],
  ['PARENT', 'Parent'],
  ['STUDENT', 'Student'],
];

export function panelLabel(roles: string[] | undefined): string {
  const r = roles ?? [];
  const match = PANEL_LABELS.find(([role]) => r.includes(role));
  return match ? match[1] : 'School Admin';
}

const LANDING: [Role, string][] = [
  ['OWNER_ADMIN', '/dashboard'],
  ['CAMPUS_ADMIN', '/dashboard'],
  ['ACCOUNTANT', '/dashboard'],
  ['ADMISSION_CONTROLLER', '/admissions'],
  ['HR_MANAGER', '/recruitment'],
  ['TEACHER', '/attendance'],
  ['STAFF', '/my-attendance'],
  ['PARENT', '/parent'],
  ['STUDENT', '/me'],
];

export function landingPath(roles: string[] | undefined): string {
  const r = roles ?? [];
  const match = LANDING.find(([role]) => r.includes(role));
  return match ? match[1] : '/dashboard';
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

/**
 * The sidebar as ordered groups, each with only the items this role may see.
 * Empty groups are dropped, so a role never sees a header with nothing under it.
 */
export function groupedNav(
  userRoles: string[] | undefined,
): { group: NavGroup; items: NavItem[] }[] {
  const visible = NAV.filter((n) => hasAnyRole(userRoles, n.roles));
  return NAV_GROUPS.map((group) => ({
    group,
    items: visible.filter((n) => n.group === group),
  })).filter((g) => g.items.length > 0);
}
