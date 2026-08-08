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
  /** Reachable by link but not listed in the sidebar. Kept in NAV so `navItemFor` still
   *  role-gates the route — dropping the entry entirely would make it open to everyone. */
  hidden?: boolean;
}

export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: '📊', group: 'Overview', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT'] },

  { href: '/admissions', label: 'Admissions', icon: '📝', group: 'Enrollment', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER'] },
  // Owner included: assigning a campus's admission officer is owner-only, so hiding the screen
  // from them left the one person who can do it unable to find it.
  { href: '/admissions-team', label: 'Admission Portal', icon: '🎓', group: 'Enrollment', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  // ADMISSION_CONTROLLER included: the API has always permitted them here, and **CSV import is
  // ADMISSION_CONTROLLER-only** while its button lives on this screen — so the one role allowed
  // to bulk-import students could not open the page that does it, and the feature was unusable
  // by anybody. Same shape as the teacher who could be marked absent but could not reach their
  // own attendance: a nav that is stricter than the API silently removes a capability.
  { href: '/students', label: 'Students', icon: '👥', group: 'Enrollment', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER'] },

  { href: '/classes', label: 'Classes', icon: '📚', group: 'Academics', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { href: '/attendance', label: 'Attendance', icon: '✅', group: 'Academics', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER'] },
  { href: '/leaves', label: 'Leave requests', icon: '🗓️', group: 'Academics', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { href: '/my-classes', label: 'My Classes', icon: '📚', group: 'Academics', roles: ['TEACHER'] },
  // The editor is admin-only (§23: CRUD for owner, own-campus for a campus admin). A teacher gets
  // `/my-timetable` below rather than this screen — they read their week, they do not build it.
  { href: '/timetable', label: 'Timetable', icon: '🕘', group: 'Academics', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { href: '/exams', label: 'Exams & Results', icon: '📄', group: 'Academics', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER'] },
  { href: '/reports', label: 'Reports', icon: '📈', group: 'Academics', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT'] },
  // Academic performance, not money — the accountant is deliberately excluded.
  { href: '/performance', label: 'Performance', icon: '🎯', group: 'Academics', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },

  { href: '/fees', label: 'Fees', icon: '💳', group: 'Finance', roles: ['OWNER_ADMIN', 'ACCOUNTANT'] },
  // A campus admin may READ the queue (it is their campus's money) but only the cashier and the
  // owner may verify — confirming a submission is what issues the receipt.
  { href: '/fee-claims', label: 'Payment submissions', icon: '🧾', group: 'Finance', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT'] },

  // The HR manager's single home. Recruitment was removed 2026-07-30 and this role's real job
  // is owning the campus staff record, so there is one staff screen, role-shaped, rather than a
  // second list of the same people.
  { href: '/staff', label: 'Staff', icon: '🧑‍💼', group: 'People', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'HR_MANAGER'] },

  { href: '/setup', label: 'School configuration', icon: '⚙️', group: 'Administration', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  // Campus admins can READ the rules they work under (weekly off, backfill window); only the
  // owner may change them, which the page states rather than hiding.
  { href: '/settings', label: 'School settings', icon: '🎚️', group: 'Administration', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { href: '/campuses', label: 'Campus Hub', icon: '🏢', group: 'Administration', roles: ['OWNER_ADMIN'] },
  // Closures are dated RECORDS, not a setting, so they get their own screen rather than another
  // section on School settings — the weekly off is one recurring rule; this is a register with
  // its own create and delete. TEACHER can read it: a teacher who cannot see the closures is a
  // teacher who turns up at a locked school. The screen hides the write controls from them.
  { href: '/calendar', label: 'School calendar', icon: '📅', group: 'Administration', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER'] },

  { href: '/me', label: 'My Dashboard', icon: '🏠', group: 'My Portal', roles: ['STUDENT'] },
  { href: '/me/attendance', label: 'My Attendance', icon: '✅', group: 'My Portal', roles: ['STUDENT'] },
  { href: '/me/timetable', label: 'My Timetable', icon: '🕘', group: 'My Portal', roles: ['STUDENT'] },
  { href: '/me/results', label: 'My Results', icon: '📄', group: 'My Portal', roles: ['STUDENT'] },
  { href: '/me/fees', label: 'My Fees', icon: '💳', group: 'My Portal', roles: ['STUDENT'] },


  // TEACHER included: the endpoint always permitted them (it is self-scoped, not role-scoped),
  // but the nav did not — so a teacher had no way to reach their own attendance at all, which
  // is the surface a teacher most needs now that they can check themselves in.
  { href: '/my-attendance', label: 'My Attendance', icon: '✅', group: 'My Portal', roles: ['STAFF', 'TEACHER'] },
  // TEACHER only: `/timetable/mine` resolves a staff profile OR a student enrolment, and a
  // non-teaching staff member has neither periods nor a reason to look for them.
  { href: '/my-timetable', label: 'My Timetable', icon: '🕘', group: 'My Portal', roles: ['TEACHER'] },
  // TEACHER added 2026-08-07, closing the gap this comment used to describe: `staff-leaves` has
  // always permitted teachers, but the nav did not — so a teacher who could be marked absent had
  // no way to file the leave that would have made it ON_LEAVE, and an authorised absence landed
  // as a plain absence that payroll then deducted. Same shape as `/my-attendance` above: a nav
  // stricter than the API does not restrict a capability, it deletes it.
  { href: '/my-leaves', label: 'My Leaves', icon: '🗓️', group: 'My Portal', roles: ['STAFF', 'TEACHER'] },
  { href: '/my-payslips', label: 'My Payslips', icon: '💵', group: 'My Portal', roles: ['STAFF', 'TEACHER'] },

  // HR reads the register but never marks it — attendance feeds pay, and the same boundary
  // that keeps salary structures owner-only applies here.
  { href: '/staff-attendance', label: 'Staff Attendance', icon: '🗓️', group: 'People', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'HR_MANAGER'] },

  // Account security is every user's own business — no `roles` (any authenticated) and reached
  // from the top bar rather than the sidebar.
  { href: '/security', label: 'Security', icon: '🔒', group: 'My Portal', hidden: true },
];

/** Roles the API mandates MFA for (mirrors MANDATORY_MFA_ROLES in auth.service). */
export const MFA_REQUIRED_ROLES = ['OWNER_ADMIN', 'ACCOUNTANT'] as const;

/**
 * Single source of truth for a multi-role user's "primary" identity — ordered most- to
 * least-privileged. Both the panel/brand label AND the post-login landing derive from this
 * one list, so they can never disagree (e.g. a TEACHER+HR_MANAGER lands on Staff and
 * is branded "HR Manager", not one of each). Keyed on the first role the user holds.
 */
const ROLE_INFO: { role: Role; label: string; landing: string }[] = [
  { role: 'PLATFORM_ADMIN', label: 'Platform Admin', landing: '/dashboard' },
  { role: 'OWNER_ADMIN', label: 'School Admin', landing: '/dashboard' },
  { role: 'CAMPUS_ADMIN', label: 'Campus Admin', landing: '/dashboard' },
  { role: 'ACCOUNTANT', label: 'Accountant', landing: '/dashboard' },
  { role: 'ADMISSION_CONTROLLER', label: 'Admission Portal', landing: '/admissions' },
  { role: 'HR_MANAGER', label: 'HR Manager', landing: '/staff' },
  { role: 'TEACHER', label: 'Teacher', landing: '/attendance' },
  { role: 'STAFF', label: 'Staff', landing: '/my-attendance' },
  // Parent portal removed 2026-07-28 (see Key Decisions). Parents have no logins and no
  // screens; landing on the admin-gated dashboard yields the shell's "Not authorized" card,
  // which is truthful, instead of a 404 on a deleted route.
  { role: 'PARENT', label: 'Parent', landing: '/dashboard' },
  { role: 'STUDENT', label: 'Student', landing: '/me' },
];

/** The highest-priority role the user holds, or undefined. */
function primaryRole(roles: string[] | undefined) {
  const r = roles ?? [];
  return ROLE_INFO.find((x) => r.includes(x.role));
}

export function panelLabel(roles: string[] | undefined): string {
  return primaryRole(roles)?.label ?? 'School Admin';
}

export function landingPath(roles: string[] | undefined): string {
  return primaryRole(roles)?.landing ?? '/dashboard';
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
 * Role gating is static, but whether a screen has anything ON it can depend on how the school
 * is configured — so a few entries need the school's mode as well.
 *
 * `/admissions` is the case today: in a DIRECT school there is no enquiry pipeline, and only
 * the admission officer can admit, so for everyone else the page's entire content is a card
 * explaining they cannot act. That is not a menu item, it is a dead end — hide it. A PIPELINE
 * school still has inquiries to manage, so admins keep it.
 *
 * The route itself stays reachable by URL (the explanatory card is still the right answer for
 * someone who lands there); this only governs what is advertised.
 */
export type AdmissionsMode = 'DIRECT' | 'PIPELINE';

function isUsable(item: NavItem, userRoles: string[] | undefined, admissionsMode?: AdmissionsMode): boolean {
  if (!hasAnyRole(userRoles, item.roles)) return false;
  if (item.href === '/admissions' && admissionsMode === 'DIRECT') {
    return (userRoles ?? []).includes('ADMISSION_CONTROLLER');
  }
  return true;
}

/**
 * True if the role may actually open `href` (same rule the app layout gates pages with).
 * Use it to hide links/tiles that would otherwise dead-end on the "Not authorized" screen —
 * e.g. a dashboard metric whose destination this role can't reach. An unknown href is
 * treated as reachable (nothing gates it).
 */
export function canReach(userRoles: string[] | undefined, href: string, admissionsMode?: AdmissionsMode): boolean {
  const item = navItemFor(href);
  return !item || isUsable(item, userRoles, admissionsMode);
}

/**
 * The sidebar as ordered groups, each with only the items this role may see.
 * Empty groups are dropped, so a role never sees a header with nothing under it.
 */
export function groupedNav(
  userRoles: string[] | undefined,
  admissionsMode?: AdmissionsMode,
): { group: NavGroup; items: NavItem[] }[] {
  const visible = NAV.filter((n) => !n.hidden && isUsable(n, userRoles, admissionsMode));
  return NAV_GROUPS.map((group) => ({
    group,
    items: visible.filter((n) => n.group === group),
  })).filter((g) => g.items.length > 0);
}
