/**
 * Role-based navigation + access (mirrors the backend `@Roles` guards, blueprint §18).
 * The API is the source of truth (returns 403); this only shapes the UI so users don't
 * see screens they can't use. `roles: undefined` ⇒ any authenticated user.
 */
// Type-only, so this stays a plain module: `IconName` is erased at compile time and importing it
// pulls no React component into anything that only wants the nav table.
import type { IconName } from '@sw/ui';

export type Role =
  | 'OWNER_ADMIN'
  | 'OPERATIONS_ADMIN'
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
  | 'School structure'
  | 'Teaching'
  | 'Finance'
  | 'People'
  | 'Administration'
  | 'My Portal';

export const NAV_GROUPS: NavGroup[] = [
  'Overview',
  'Enrollment',
  'School structure',
  'Teaching',
  'Finance',
  'People',
  'Administration',
  'My Portal',
];

export interface NavItem {
  href: string;
  label: string;
  /**
   * ⚠️ **A name from the icon set, not a glyph.** This was `string` holding an emoji, which is
   * why the sidebar could never match the palette: an emoji is painted by the OS in its own fixed
   * colours and cannot inherit `currentColor`. Typing it as `IconName` means a new nav entry
   * cannot quietly reintroduce one — it has to pick an icon that actually exists.
   */
  icon: IconName;
  group: NavGroup;
  roles?: Role[];
  /** Reachable by link but not listed in the sidebar. Kept in NAV so `navItemFor` still
   *  role-gates the route — dropping the entry entirely would make it open to everyone. */
  hidden?: boolean;
}

export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: 'dashboard', group: 'Overview', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT'] },

  { href: '/admissions', label: 'Admissions', icon: 'admissions', group: 'Enrollment', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER'] },
  // Owner included: assigning a campus's admission officer is owner-only, so hiding the screen
  // from them left the one person who can do it unable to find it.
  { href: '/admissions-team', label: 'Admission Portal', icon: 'admissions-team', group: 'Enrollment', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  // ADMISSION_CONTROLLER included: the API has always permitted them here, and **CSV import is
  // ADMISSION_CONTROLLER-only** while its button lives on this screen — so the one role allowed
  // to bulk-import students could not open the page that does it, and the feature was unusable
  // by anybody. Same shape as the teacher who could be marked absent but could not reach their
  // own attendance: a nav that is stricter than the API silently removes a capability.
  { href: '/students', label: 'Students', icon: 'students', group: 'Enrollment', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER'] },

  { href: '/classes', label: 'Classes', icon: 'classes', group: 'School structure', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  // The cross-class view of subjects (who teaches what, where it is short, periods/week). Sits
  // beside Classes; both move into a 'School structure' group in IA5.
  { href: '/subjects', label: 'Subjects', icon: 'classes', group: 'School structure', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { href: '/attendance', label: 'Attendance', icon: 'attendance', group: 'Teaching', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER'] },
  { href: '/leaves', label: 'Leave requests', icon: 'leaves', group: 'Teaching', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { href: '/my-classes', label: 'My Classes', icon: 'classes', group: 'Teaching', roles: ['TEACHER'] },
  // The editor is admin-only (§23: CRUD for owner, own-campus for a campus admin). A teacher gets
  // `/my-timetable` below rather than this screen — they read their week, they do not build it.
  { href: '/timetable', label: 'Timetable', icon: 'timetable', group: 'School structure', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  // Directly under Timetable, because it is the thing you must set FIRST: the grid renders the day
  // this screen declares. Same roles as the editor — a campus admin composes their own campus's day
  // and the service refuses anyone else's.
  { href: '/timings', label: 'School Timings', icon: 'timings', group: 'School structure', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  // Arranging cover is a permission grant — it lets one teacher write to another class's
  // register — so it sits with the people who approve leave, not with teachers.
  { href: '/cover', label: 'Cover', icon: 'cover', group: 'Teaching', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { href: '/exams', label: 'Exams & Results', icon: 'exams', group: 'Teaching', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER'] },
  { href: '/reports', label: 'Reports', icon: 'reports', group: 'Overview', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT'] },
  // Academic performance, not money — the accountant is deliberately excluded.
  { href: '/performance', label: 'Performance', icon: 'performance', group: 'Overview', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },

  { href: '/fees', label: 'Fees', icon: 'fees', group: 'Finance', roles: ['OWNER_ADMIN', 'ACCOUNTANT'] },
  // A campus admin may READ the queue (it is their campus's money) but only the cashier and the
  // owner may verify — confirming a submission is what issues the receipt.
  { href: '/fee-claims', label: 'Payment submissions', icon: 'fee-claims', group: 'Finance', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT'] },

  // The HR manager's single home. Recruitment was removed 2026-07-30 and this role's real job
  // is owning the campus staff record, so there is one staff screen, role-shaped, rather than a
  // second list of the same people.
  { href: '/staff', label: 'Staff', icon: 'staff', group: 'People', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'HR_MANAGER'] },

  { href: '/setup', label: 'School configuration', icon: 'setup', group: 'Administration', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  // Campus admins can READ the rules they work under (weekly off, backfill window); only the
  // owner may change them, which the page states rather than hiding.
  { href: '/settings', label: 'School settings', icon: 'settings', group: 'Administration', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { href: '/campuses', label: 'Campus Hub', icon: 'campuses', group: 'School structure', roles: ['OWNER_ADMIN'] },
  // Closures are dated RECORDS, not a setting, so they get their own screen rather than another
  // section on School settings — the weekly off is one recurring rule; this is a register with
  // its own create and delete. TEACHER can read it: a teacher who cannot see the closures is a
  // teacher who turns up at a locked school. The screen hides the write controls from them.
  { href: '/calendar', label: 'School calendar', icon: 'calendar', group: 'Administration', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER'] },
  // The product texts parents (fees, absence, results); this is the only window into the
  // templates, the credit balance, and what was actually sent. Editing templates is owner-only
  // (enforced in the API); a campus admin reads.
  { href: '/sms', label: 'SMS & notifications', icon: 'message', group: 'Administration', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },

  // Teacher phone shell (Teacher Mobile Home Plan M0/M1). `hidden` keeps them out of the sidebar
  // - they are tab-bar destinations - while still being IN `NAV`, which is what makes
  // `navItemFor` role-gate them. Leaving them out entirely would have made both routes reachable
  // by every signed-in role, since the shell treats an unknown path as unrestricted.
  // STAFF added 2026-09-06 (Phase 3): a non-teaching staff member had NO home at all.
  // ADMISSION_CONTROLLER + HR_MANAGER added 2026-09-06 (Phase 2): `/dashboard` is
  // `@Roles('OWNER_ADMIN','CAMPUS_ADMIN','ACCOUNTANT')` on the API, so these two could not open it
  // either — they had no overview of any kind and dropped straight into a work screen.
  { href: '/home', label: 'Home', icon: 'home', group: 'My Portal', roles: ['TEACHER', 'STAFF', 'ADMISSION_CONTROLLER', 'HR_MANAGER'], hidden: true },
  { href: '/me-more', label: 'More', icon: 'profile', group: 'My Portal', roles: ['TEACHER'], hidden: true },

  { href: '/me', label: 'My Dashboard', icon: 'home', group: 'My Portal', roles: ['STUDENT'] },
  { href: '/me/attendance', label: 'My Attendance', icon: 'attendance', group: 'My Portal', roles: ['STUDENT'] },
  { href: '/me/timetable', label: 'My Timetable', icon: 'timetable', group: 'My Portal', roles: ['STUDENT'] },
  { href: '/me/results', label: 'My Results', icon: 'exams', group: 'My Portal', roles: ['STUDENT'] },
  { href: '/me/fees', label: 'My Fees', icon: 'fees', group: 'My Portal', roles: ['STUDENT'] },


  // TEACHER included: the endpoint always permitted them (it is self-scoped, not role-scoped),
  // but the nav did not — so a teacher had no way to reach their own attendance at all, which
  // is the surface a teacher most needs now that they can check themselves in.
  { href: '/my-attendance', label: 'My Attendance', icon: 'attendance', group: 'My Portal', roles: ['STAFF', 'TEACHER'] },
  // TEACHER only: `/timetable/mine` resolves a staff profile OR a student enrolment, and a
  // non-teaching staff member has neither periods nor a reason to look for them.
  { href: '/my-timetable', label: 'My Timetable', icon: 'timetable', group: 'My Portal', roles: ['TEACHER'] },
  // TEACHER added 2026-08-07, closing the gap this comment used to describe: `staff-leaves` has
  // always permitted teachers, but the nav did not — so a teacher who could be marked absent had
  // no way to file the leave that would have made it ON_LEAVE, and an authorised absence landed
  // as a plain absence that payroll then deducted. Same shape as `/my-attendance` above: a nav
  // stricter than the API does not restrict a capability, it deletes it.
  { href: '/my-leaves', label: 'My Leaves', icon: 'leaves', group: 'My Portal', roles: ['STAFF', 'TEACHER'] },
  { href: '/my-payslips', label: 'My Payslips', icon: 'payslips', group: 'My Portal', roles: ['STAFF', 'TEACHER'] },

  // HR reads the register but never marks it — attendance feeds pay, and the same boundary
  // that keeps salary structures owner-only applies here.
  { href: '/staff-attendance', label: 'Staff Attendance', icon: 'leaves', group: 'People', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'HR_MANAGER'] },

  // Account security is every user's own business — no `roles` (any authenticated) and reached
  // from the top bar rather than the sidebar.
  { href: '/security', label: 'Security', icon: 'lock', group: 'My Portal', hidden: true },
  // A read-only "my details" page, every user's own business (no `roles`). `hidden` because it is
  // pinned to the panel footer / reached from the top bar, not auto-listed among the screens.
  { href: '/profile', label: 'Profile', icon: 'profile', group: 'My Portal', hidden: true },
];

/**
 * Which audience each front-end door serves (Front-End Instance Separation Plan, Phase 4).
 *
 * The split gave each audience its own origin, but the shared shell never learned which app it was
 * rendering in — it built the sidebar from the user's roles alone. So owner-web and staff-web mounted
 * the same 33 screens and rendered identically for anyone holding admin roles, and the separation was
 * cosmetic. These are the audiences the apps' own layouts already declare in prose; stating them as
 * data lets the mount list be DERIVED rather than hand-kept.
 *
 * ⚠️ This is an information-architecture boundary, NOT an authorization one. Authorization is enforced
 * per request in the API regardless of host; narrowing a door cannot grant anything, and widening one
 * cannot leak anything. Never rely on this for access control.
 */
export type AppName = 'owner-web' | 'staff-web';

export const APP_AUDIENCE: Record<AppName, readonly Role[]> = {
  // The owner alone. ⚠️ NOT the OPERATIONS_ADMIN deputy: staff-web's layout declares it serves
  // "ops/campus-admin/...", and including it here would silently widen this door to everything —
  // the deputy expands to six covered roles, which is exactly what made a first attempt at this
  // prune a no-op.
  'owner-web': ['OWNER_ADMIN'],
  // Everyone else who works at the school — as staff-web's own layout puts it, it
  // "serves ops/campus-admin/accountant/HR/admission/teacher/staff".
  'staff-web': ['OPERATIONS_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER', 'HR_MANAGER', 'ACCOUNTANT', 'TEACHER', 'STAFF'],
};

/**
 * The routes an app should mount: every NAV href reachable by at least one role in its audience.
 *
 * Hidden entries with no `roles` (`/security`, `/profile`) are every user's own business and are
 * reachable by everyone, so they mount everywhere — which is what `canReach` already says about them.
 */
export function appMounts(app: AppName, admissionsMode?: AdmissionsMode): string[] {
  const audience = APP_AUDIENCE[app];
  return NAV.filter((n) => audience.some((role) => canReach([role], n.href, admissionsMode))).map((n) => n.href);
}

/**
 * True when `href` belongs on this door at all. Used to intersect the role-derived nav with the
 * app's mounts, so a multi-role user never sees a sidebar link to a screen this app does not serve.
 *
 * ⚠️ Without this intersection, pruning mounts would CREATE 404s: the sidebar is built from the
 * user's roles, so an owner who also teaches would still be offered `/my-classes` on the owner door
 * after that route stopped existing there.
 */
export function servesRoute(app: AppName | undefined, href: string, admissionsMode?: AdmissionsMode): boolean {
  if (!app) return true; // unknown app (e.g. the marketing shell) keeps today's behaviour
  return appMounts(app, admissionsMode).includes(href);
}

/** Roles the API mandates MFA for (mirrors MANDATORY_MFA_ROLES in auth.service). */
export const MFA_REQUIRED_ROLES = ['OWNER_ADMIN', 'OPERATIONS_ADMIN', 'ACCOUNTANT'] as const;

/**
 * Roles the OPERATIONS_ADMIN deputy stands in for (mirrors OPERATIONS_ADMIN_COVERS in the backend
 * libs/common role-hierarchy). It is the owner's operational deputy, so for UI gating it satisfies
 * every role below itself — never OWNER_ADMIN, so owner-only screens (Campus Hub, module access)
 * stay owner-only exactly as the API enforces.
 */
const OPERATIONS_ADMIN_COVERS: Role[] = ['CAMPUS_ADMIN', 'ADMISSION_CONTROLLER', 'HR_MANAGER', 'ACCOUNTANT', 'TEACHER', 'STAFF'];

/** Effective roles for UI gating: expands an OPERATIONS_ADMIN to the roles it covers so the sidebar
 *  shows the same screens the API will let it open. Every other role passes through unchanged. */
function effectiveRoles(userRoles: string[] | undefined): string[] {
  const r = userRoles ?? [];
  return r.includes('OPERATIONS_ADMIN') ? Array.from(new Set([...r, ...OPERATIONS_ADMIN_COVERS])) : r;
}

/**
 * Single source of truth for a multi-role user's "primary" identity — ordered most- to
 * least-privileged. Both the panel/brand label AND the post-login landing derive from this
 * one list, so they can never disagree (e.g. a TEACHER+HR_MANAGER lands on Staff and
 * is branded "HR Manager", not one of each). Keyed on the first role the user holds.
 */
const ROLE_INFO: { role: Role; label: string; landing: string; title?: string }[] = [
  { role: 'OWNER_ADMIN', label: 'School Admin', landing: '/dashboard' },
  // The owner's operational deputy — sits directly below the owner and lands on the same dashboard.
  { role: 'OPERATIONS_ADMIN', label: 'Ops Admin', landing: '/dashboard' },
  { role: 'CAMPUS_ADMIN', label: 'Campus Admin', landing: '/dashboard' },
  { role: 'ACCOUNTANT', label: 'Accountant', landing: '/dashboard' },
  // ⚠️ `label` names the PANEL ("Admission Portal" is the screen they land in); `title` names the
  // PERSON. Only this role needed the split — a chip reading "Admission Portal" would be telling
  // Ayesha her job is a screen. Everywhere else the panel label already reads as a job title.
  // Landing moved to `/home` 2026-09-06 (Phase 2) — same reasoning as the teacher's move off
  // `/attendance`: the pipeline is still one click away, and the home says what is waiting first.
  { role: 'ADMISSION_CONTROLLER', label: 'Admission Portal', landing: '/home', title: 'Admission Controller' },
  { role: 'HR_MANAGER', label: 'HR Manager', landing: '/home' },
  // Landing moved from `/attendance` to `/home` 2026-08-08 (Teacher Mobile Home Plan 7.2).
  // `/attendance` is a work screen - it opened cold, with no idea which section was wanted.
  { role: 'TEACHER', label: 'Teacher', landing: '/home' },
  // Landing moved from `/my-attendance` to `/home` 2026-09-06 (Phase 3) — same reasoning as the
  // teacher's move off `/attendance`: a records screen is where you go to look something up, not
  // where a working day should start.
  { role: 'STAFF', label: 'Staff', landing: '/home' },
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

/**
 * **Every** hat this person wears, in human words (operator, 2026-09-06).
 *
 * ⚠️ **The shell used to under- and over-state this at the same time.** The sidebar brand showed
 * `panelLabel` — ONE role — so a teacher who also ran admissions and HR was branded plainly
 * "Teacher" and her other two jobs were invisible; meanwhile the top bar printed the raw enums
 * (`TEACHER, ADMISSION_CONTROLLER, HR_MANAGER`), which is a database value, not a job title. This
 * is the one place that answers "who am I here?", so the brand can keep naming the *panel* while
 * the chips name the *person*.
 *
 * **Held roles only — never `effectiveRoles`.** An Ops Admin satisfies six lower roles by
 * hierarchy; listing those would tell a deputy she is a Teacher and an Accountant, which is a claim
 * about her job rather than about her permissions.
 *
 * Ordered by `ROLE_INFO` (most- to least-privileged) so the list reads the same everywhere, and an
 * unrecognised/future role is prettified rather than dropped — a role silently missing from the one
 * screen that states your identity is worse than an imperfect label.
 */
export function roleLabels(roles: string[] | undefined): string[] {
  const held = new Set(roles ?? []);
  const known = ROLE_INFO.filter((x) => held.has(x.role)).map((x) => x.title ?? x.label);
  const unknown = [...held]
    .filter((r) => !ROLE_INFO.some((x) => x.role === r))
    .map((r) => r.toLowerCase().split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
  return [...known, ...unknown];
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

/** True if the user holds any of the allowed roles (or the item is unrestricted). An Ops admin is
 *  expanded to the roles it covers first, so it matches every screen a campus admin/below can open. */
export function hasAnyRole(userRoles: string[] | undefined, allowed?: Role[]): boolean {
  if (!allowed || allowed.length === 0) return true;
  return effectiveRoles(userRoles).some((r) => (allowed as string[]).includes(r));
}

/**
 * Owner-level configuration authority: the school **owner** OR their **Operations Admin** deputy —
 * and no one else (a campus admin is deliberately excluded). Mirrors the backend routes gated
 * `@Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN')` — school settings, academic years, campus create/delete,
 * fee & exam setup, SMS templates, the admission seat. Use it to show/enable those write controls so
 * the deputy's UI matches what the API will accept. (Not `hasAnyRole`, because that expands Ops to
 * the roles it covers, which would also admit a campus admin here.)
 */
export function isSchoolWideAdmin(roles: string[] | undefined): boolean {
  const r = roles ?? [];
  return r.includes('OWNER_ADMIN') || r.includes('OPERATIONS_ADMIN');
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
    return effectiveRoles(userRoles).includes('ADMISSION_CONTROLLER');
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
const TEACHER_TABS: { href: string; label: string; icon: IconName }[] = [
  { href: '/home', label: 'Home', icon: 'home' },
  { href: '/attendance', label: 'Attendance', icon: 'attendance' },
  { href: '/my-timetable', label: 'Week', icon: 'timetable' },
  // "More", not "Me": for a teacher who also keeps the books this tab holds Dashboard, Fees,
  // Payment submissions and Reports — a whole second job under a person icon. It was already
  // slightly wrong for a plain teacher, whose Exams & Results and School calendar are not
  // personal either.
  { href: '/me-more', label: 'More', icon: 'profile' },
];

/**
 * Roles that keep the administrator's shell even when the person also teaches.
 *
 * An owner or campus admin who happens to take a class still runs the school, and a four-item rail
 * cannot carry that job.
 */
const ADMIN_SHELL_ROLES: readonly Role[] = ['OWNER_ADMIN', 'CAMPUS_ADMIN'];

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

/**
 * Roles that come with a job of their own, and therefore a screen of their own to run it from.
 * Someone holding any of these keeps the administrator's grouped sidebar even if they are also on
 * the payroll as STAFF.
 */
const JOB_ROLES: readonly Role[] = [
  'OWNER_ADMIN', 'OPERATIONS_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT',
  'ADMISSION_CONTROLLER', 'HR_MANAGER', 'TEACHER',
];

/**
 * A **plain** staff member: on the payroll, with no second job in the system — the office assistant,
 * the driver, the lab attendant, the guard.
 *
 * ⚠️ **Deliberately narrow.** An ACCOUNTANT or HR_MANAGER who also carries STAFF must NOT be swept
 * in here: they have a dashboard and a job to run, and flipping their shell and their landing page
 * would be a regression for people who are working fine today. Only someone with *nothing but*
 * STAFF qualifies, which is exactly the person Phase 3 is about.
 */
export function isPlainStaff(roles: string[] | undefined): boolean {
  const r = roles ?? [];
  return r.includes('STAFF') && !r.some((x) => (JOB_ROLES as readonly string[]).includes(x));
}

/**
 * True when this person should be offered **Home** in the administrator's grouped sidebar
 * (Role-Based Home Dashboard Plan, Phase 2).
 *
 * ⚠️ **`/home` is `hidden` in `NAV`, so it renders nowhere on the admin sidebar** — the phone tab bar
 * owns it. Phase 3 solved that for plain staff by giving them the personal rail, but an Admission
 * Controller or HR Manager needs the *grouped* sidebar: they have a real job with many screens. So
 * they get an explicit Home entry instead, and without it they would land on a screen they could not
 * navigate back to — the T0 regression, again.
 *
 * **Only for people who have no `/dashboard`.** `/dashboard` is `@Roles('OWNER_ADMIN',
 * 'CAMPUS_ADMIN', 'ACCOUNTANT')` on the API, so an admission officer and an HR manager have no
 * overview of any kind, while an owner/campus admin/accountant (and an Ops deputy, by hierarchy)
 * already have one and must not be handed a second, competing front door.
 */
export function needsHomeLink(roles: string[] | undefined): boolean {
  return canReach(roles, '/home') && !canReach(roles, '/dashboard');
}

/**
 * Who gets the **personal shell** — the compact one built around a person's own day (a short flat
 * rail, Profile pinned at the foot, a phone tab bar) rather than the administrator's grouped filing
 * system (Role-Based Home Dashboard Plan, Phase 3).
 *
 * ⚠️ **Plain staff had no home at all, and could not have been given one without this.** `/home` is
 * `hidden` in `NAV` so the phone bar can own it, so on the admin sidebar it renders nowhere: a staff
 * member landing there would have had no link back to the screen they start on — the exact T0
 * regression that created the teacher shell ("landed on Home, clicked anything, and could only get
 * back with the browser's back button"). The personal rail lists `/home` explicitly, so giving them
 * the shell and giving them the home are one decision, not two.
 *
 * Their rail comes out short and correct on its own: `teacherSidebarNav` flattens `groupedNav` minus
 * `My Portal`, and a plain staff member's only entries ARE `My Portal` — so they get **Home** and the
 * pinned **Profile**, with their attendance, leaves and payslips inside it. `tabsFor` likewise
 * reduces to Home + More, because the other two tabs are `canReach`-filtered away.
 *
 * The brand still reads "Staff", not "Teacher": `panelLabel` keys off `usesTeacherShell`, which this
 * deliberately does not widen.
 */
export function usesPersonalShell(roles: string[] | undefined): boolean {
  return usesTeacherShell(roles) || isPlainStaff(roles);
}

/** Tabs this user can actually open. `/home` and `/me-more` are teacher-only routes with no NAV
 *  entry of their own, so they pass through; the rest face the same gate as the sidebar. */
export function tabsFor(roles: string[] | undefined, admissionsMode?: AdmissionsMode) {
  return TEACHER_TABS.filter((t) =>
    t.href === '/home' || t.href === '/me-more' || canReach(roles, t.href, admissionsMode));
}

/**
 * The sections of `/home`, one per hat the person wears (Role-Based Home Dashboard Plan, Phase 1).
 *
 * ⚠️ **`/home` was a single-role screen and multi-hat staff are normal here.** A teacher who also
 * ran admissions and HR saw only teacher work — her entry test today and her HR queue were invisible
 * until she remembered to go and click those screens, and on a day with no timetable the page told
 * her "Nothing scheduled" while she had two other jobs. A home that under-reports work is worse than
 * no home, because it is trusted.
 *
 * Only roles that can actually co-occur with TEACHER appear here: `/home` is `roles: ['TEACHER']`,
 * and an owner or campus admin keeps the ADMIN shell (`usesTeacherShell`) and its own `/dashboard`.
 * Adding a section later is one row plus its card — never an `if` in the page.
 */
export type HomeSection = 'TEACHING' | 'ADMISSIONS' | 'HR' | 'MY_DAY';

const HOME_SECTIONS: { key: HomeSection; roles: Role[] }[] = [
  { key: 'TEACHING', roles: ['TEACHER'] },
  { key: 'ADMISSIONS', roles: ['ADMISSION_CONTROLLER'] },
  { key: 'HR', roles: ['HR_MANAGER'] },
  // Phase 3: the non-teaching staff member's own day — check-in, attendance, leaves, payslips.
  // Last by design: for anyone who also teaches, the register closes today and this does not.
  { key: 'MY_DAY', roles: ['STAFF'] },
];

/**
 * Which sections this person's home shows, **in the order they should read**.
 *
 * ⚠️ **Ordered by urgency, NOT by `ROLE_INFO` rank.** That list orders roles by *privilege* — HR
 * Manager outranks Teacher — and privilege is the wrong axis for a to-do list: a register is
 * time-boxed and closes today, an HR queue is weekly. The rule is **the shell's own job leads, then
 * `ROLE_INFO` order for the rest**. `/home` only exists in the teacher shell, so TEACHING leads; that
 * keeps one stated rule instead of a per-person judgement, and it cannot disagree with which app she
 * is looking at.
 *
 * **Held roles only, never `effectiveRoles`** — same reasoning as `roleLabels`: an Ops deputy
 * satisfies six lower roles by hierarchy, and sprouting a Teaching section on her home would be a
 * claim about her job rather than her permissions.
 */
export function homeSections(userRoles: string[] | undefined): HomeSection[] {
  const held = new Set(userRoles ?? []);
  const rank = (s: { key: HomeSection; roles: Role[] }) =>
    // The shell owns TEACHING, so it leads regardless of privilege.
    s.key === 'TEACHING' ? -1 : ROLE_INFO.findIndex((x) => s.roles.includes(x.role));
  return HOME_SECTIONS
    .filter((s) => s.roles.some((r) => held.has(r)))
    .sort((a, b) => rank(a) - rank(b))
    .map((s) => s.key);
}

/**
 * The person's OWN records — "everything related to herself" (operator, 2026-09-06).
 *
 * `My Portal` is the group `NAV` already uses for exactly this: My Attendance, My Timetable, My
 * Leaves, My Payslips. It is the line between *the job* and *the employee* — note that **My Classes
 * is NOT here** (it is `Teaching`, i.e. work she does for the school), which is why this keys off
 * the existing group rather than a `startsWith('/my-')` guess on the label.
 */
export const SELF_SERVICE_GROUP: NavGroup = 'My Portal';

/**
 * The self-service list rendered INSIDE Profile, so a teacher has one place for her own things.
 *
 * A projection of `NAV` like every other nav helper — `groupedNav` has already dropped `hidden`
 * entries (`/home`, `/me-more`, `/security`, `/profile`) and filtered to what this person may
 * reach, so an item she cannot open never appears, and Profile can never drift from the sidebar.
 */
export function selfServiceNav(
  userRoles: string[] | undefined,
  admissionsMode?: AdmissionsMode,
): { href: string; label: string; icon: IconName }[] {
  return groupedNav(userRoles, admissionsMode)
    .filter((g) => g.group === SELF_SERVICE_GROUP)
    .flatMap((g) => g.items)
    .map((n) => ({ href: n.href, label: n.label, icon: n.icon }));
}

/**
 * The teacher's desktop left panel — every screen she may reach, listed flat, **work only**.
 *
 * ⚠️ **This deliberately reverses `tabsFor`'s "four everywhere" rule for the desktop panel.** The
 * phone tab bar still holds four hot destinations (a phone bar past four is unreadable), but on a
 * laptop the left panel lists everything instead of hiding the rest behind "More" — the operator
 * asked for a complete menu, not a stub.
 *
 * ⚠️ **`My Portal` is excluded (operator, 2026-09-06): her own attendance, timetable, leaves and
 * payslips moved into Profile**, so the panel is the school's work and the pinned Profile footer is
 * her own record. Anything self-service therefore has exactly ONE home, and adding a `My Portal`
 * entry to `NAV` tomorrow lands there automatically instead of re-cluttering this list.
 *
 * **Still a projection of `NAV`, never a second list** (the discipline `tabsFor` and `me-more`
 * keep): it flattens `groupedNav` and prepends `/home` (which is `hidden` only so the phone bar can
 * own it). `/profile` is `hidden` too, and the panel renders its pinned footer itself.
 */
export function teacherSidebarNav(
  userRoles: string[] | undefined,
  admissionsMode?: AdmissionsMode,
): { href: string; label: string; icon: IconName }[] {
  const home = NAV.find((n) => n.href === '/home');
  const rest = groupedNav(userRoles, admissionsMode)
    .filter((g) => g.group !== SELF_SERVICE_GROUP)
    .flatMap((g) => g.items)
    .filter((n) => n.href !== '/home');
  return [...(home ? [home] : []), ...rest].map((n) => ({ href: n.href, label: n.label, icon: n.icon }));
}

export { doorOrigin, DEV_DOOR_PORTS, type Door, type LocationLike } from './door-url';

/**
 * Who may correct money already recorded — mirrored from the API's `@Roles`, so the fee screens show
 * exactly the buttons the server will accept.
 *
 * ⚠️ These are the API's own lists, not "who ought to". Change one here only alongside the matching
 * `@Roles` in `apps/api/src/modules/fees/fees.controller.ts`; `fee-permissions.spec.ts` pins the result
 * for every role, including the deputy, who reaches ADVANCES through the role hierarchy but reaches
 * reverse and waive because OPERATIONS_ADMIN is named outright.
 */
export const FEE_REVERSE_WAIVE_ROLES: Role[] = ['OWNER_ADMIN', 'OPERATIONS_ADMIN'];
export const FEE_ADVANCE_ROLES: Role[] = ['OWNER_ADMIN', 'ACCOUNTANT'];

