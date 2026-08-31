/**
 * The names in the app's icon set — a plain string-union **type**, deliberately react-free.
 *
 * It lives in the shared `@sw/ui` package (Front-End Instance Separation Plan, Phase 0) because two
 * different consumers need it: the `@sw/roles` nav table types `NavItem.icon` as an `IconName`, and
 * each app's `<Icon>` component maps these names to SVG paths. Keeping the TYPE here (no React) lets
 * `@sw/roles` stay a pure-logic package while the actual `<Icon>` component (which needs React) lives
 * in the app until the shared UI package gets its own React toolchain (workspace, Phase 1).
 */
export type IconName =
  // navigation
  | 'dashboard' | 'admissions' | 'admissions-team' | 'students' | 'classes' | 'attendance'
  | 'leaves' | 'timetable' | 'timings' | 'cover' | 'exams' | 'reports' | 'performance' | 'fees'
  | 'fee-claims' | 'staff' | 'setup' | 'settings' | 'campuses' | 'calendar' | 'home'
  | 'profile' | 'payslips' | 'lock' | 'school'
  // dashboard + chrome
  | 'alert' | 'message' | 'bell' | 'chevron-right' | 'trend-up'
  // register states — present / absent / on leave / not yet marked
  | 'check-circle' | 'x-circle' | 'leave' | 'unknown' | 'inbox' | 'menu';
