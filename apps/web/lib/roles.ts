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
  // Arranging cover is a permission grant — it lets one teacher write to another class's
  // register — so it sits with the people who approve leave, not with teachers.
  { href: '/cover', label: 'Cover', icon: '🔁', group: 'Academics', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
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

  // Teacher phone shell (Teacher Mobile Home Plan M0/M1). `hidden` keeps them out of the sidebar
  // - they are tab-bar destinations - while still being IN `NAV`, which is what makes
  // `navItemFor` role-gate them. Leaving them out entirely would have made both routes reachable
  // by every signed-in role, since the shell treats an unknown path as unrestricted.
  { href: '/home', label: 'Home', icon: '🏠', group: 'My Portal', roles: ['TEACHER'], hidden: true },
  { href: '/me-more', label: 'More', icon: '👤', group: 'My Portal', roles: ['TEACHER'], hidden: true },

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
  // Landing moved from `/attendance` to `/home` 2026-08-08 (Teacher Mobile Home Plan 7.2).
  // `/attendance` is a work screen - it opened cold, with no idea which section was wanted.
  { role: 'TEACHER', label: 'Teacher', landing: '/home' },
  { role: 'STAFF', label: 'Staff', landing: '/my-attendance' },
  // Parent portal removed 2026-07-28 (see Key Decisions). Parents have no logins and no
  // screens; landing on the admin-gated dashboard yields the shell's "Not authorized" card,
  // which is truthful, instead of a 404 on a deleted route.
  { role: 'PARENT', label: 'Parent', landing: '/dashboard' },
  { role: 'STUDENT', label: 'Student', landing: '/me' },
];

/** The highest-priority role the user holds, or undefined. */
export function primaryRole(roles: string[] | undefined) {
  const r = roles ?? [];
  return ROLE_INFO.find((x) => r.includes(x.role));
}

export function panelLabel(roles: string[] | undefined): string {
  // The teacher shell says "Teacher" even for someone who also keeps the books — the shell they
  // are looking at IS the teacher app, and naming it after their other job would describe a
  // navigation that is not on the screen.
  if (usesTeacherShell(roles)) return 'Teacher';
  return primaryRole(roles)?.label ?? 'School Admin';
}

/**
 * ⚠️ **Changed for T1, and it changes where existing people land.** Anyone on the teacher shell
 * opens on `/home`: they are being handed the teacher app, so starting them on another job's
 * dashboard contradicts it — and Home is one tap from everything else. An accountant-who-teaches
 * who opens on `/dashboard` today will open on Home after this.
 */
export function landingPath(roles: string[] | undefined): string {
  if (usesTeacherShell(roles)) return '/home';
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

/**
 * The teacher's bottom tab bar (Teacher Mobile Home Plan 7.1).
 *
 * **A projection of `NAV`, never a second list.** With only one role using the tab bar, hardcoding
 * four links here would be the obvious shortcut - and a nav that stops agreeing with the
 * permissions behind it is how this codebase has silently *deleted* capability three times: CSV
 * import, `/my-attendance`, and `/my-leaves` each became unreachable because the nav was stricter
 * than the API. Every entry below is checked against `NAV`, so an item a teacher may not reach
 * simply does not appear rather than becoming a dead tab.
 *
 * **Four, deliberately.** A phone tab bar past four items becomes unreadable at thumb size, and
 * the fifth is always the one nobody taps. Everything visited monthly rather than hourly - leaves,
 * payslips, exams, calendar, my attendance - lives behind **Me**.
 */
const TEACHER_TABS: { href: string; label: string; icon: string }[] = [
  { href: '/home', label: 'Home', icon: '🏠' },
  { href: '/attendance', label: 'Attendance', icon: '✅' },
  { href: '/my-timetable', label: 'Week', icon: '🕘' },
  // "More", not "Me": for a teacher who also keeps the books this tab holds Dashboard, Fees,
  // Payment submissions and Reports — a whole second job under a person icon. It was already
  // slightly wrong for a plain teacher, whose Exams & Results and School calendar are not
  // personal either.
  { href: '/me-more', label: 'More', icon: '👤' },
];

/**
 * Roles that keep the administrator's shell even when the person also teaches.
 *
 * An owner or campus admin who happens to take a class still runs the school, and a four-item rail
 * cannot carry that job. PLATFORM_ADMIN is included for the same reason — it is an administrator,
 * of the platform rather than of one school — although the combination should not occur.
 */
const ADMIN_SHELL_ROLES: readonly Role[] = ['PLATFORM_ADMIN', 'OWNER_ADMIN', 'CAMPUS_ADMIN'];

/**
 * True when this person should get the teacher app — at **every** width (Teacher App Shell Plan,
 * T0/T1).
 *
 * ⚠️ **It used to be `primaryRole(roles)?.role === 'TEACHER'`, and that silently excluded most
 * teachers who wear a second hat.** `primaryRole` returns the first match in `ROLE_INFO` order and
 * TEACHER sits **7th**, behind ACCOUNTANT, ADMISSION_CONTROLLER and HR_MANAGER — so a teacher who
 * also handled admissions got the Admission Portal shell with no tab bar and no Home, *on a phone
 * as well as a laptop*. In a small Pakistani private school the teacher who also does one
 * administrative job is normal staffing, not an edge case.
 *
 * The rule is now stated directly rather than falling out of a list's ordering: **hold TEACHER and
 * you get the teacher app, unless you also administer the school.** Their other job is not lost —
 * it is one tap away under **More**, which is built from the person's roles.
 *
 * @see landingPath and panelLabel, which follow this rather than `primaryRole`, so the shell, the
 *      screen you land on and the name in the corner cannot disagree about who you are.
 */
export function usesTeacherShell(roles: string[] | undefined): boolean {
  const r = roles ?? [];
  return r.includes('TEACHER') && !r.some((x) => (ADMIN_SHELL_ROLES as readonly string[]).includes(x));
}

/** Tabs this user can actually open. `/home` and `/me-more` are teacher-only routes with no NAV
 *  entry of their own, so they pass through; the rest face the same gate as the sidebar. */
export function tabsFor(roles: string[] | undefined, admissionsMode?: AdmissionsMode) {
  return TEACHER_TABS.filter((t) =>
    t.href === '/home' || t.href === '/me-more' || canReach(roles, t.href, admissionsMode));
}
