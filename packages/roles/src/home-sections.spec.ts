import { canReach, homeSections, isPlainStaff, landingPath, needsHomeLink, panelLabel, roleLabels, usesPersonalShell } from './index';

/**
 * The rules behind the divided home (Role-Based Home Dashboard Plan, Phase 1) and the role chips.
 *
 * These are **pure functions that decide what a person sees**, which makes them the cheapest and
 * highest-value things in the front end to test — and until now `packages/*` had no unit coverage at
 * all (the split moved this logic out of `apps/web`, where nothing tested it either). The e2e specs
 * prove the screens render; these prove the rules, including the combinations no seeded demo user
 * happens to have.
 */
describe('homeSections — one section per hat', () => {
  it('gives a single-role teacher nothing but teaching (the no-regression case)', () => {
    // ⚠️ The load-bearing case: ~90% of staff wear one hat, and for them this change must be a
    // pure addition. An extra section here would mean an extra fetch and a heading they never had.
    expect(homeSections(['TEACHER'])).toEqual(['TEACHING']);
  });

  it('orders by urgency — the shell’s own job leads, then ROLE_INFO', () => {
    // Not privilege order: ROLE_INFO ranks HR Manager and Admission Controller ABOVE Teacher, but
    // a register closes today and an HR queue is weekly. `/home` is the teacher shell, so teaching
    // leads; admissions precedes HR because that is ROLE_INFO's order for the remainder.
    expect(homeSections(['HR_MANAGER', 'ADMISSION_CONTROLLER', 'TEACHER'])).toEqual([
      'TEACHING', 'ADMISSIONS', 'HR',
    ]);
    // Order is a property of the ROLES, never of the order they arrive in.
    expect(homeSections(['TEACHER', 'HR_MANAGER'])).toEqual(['TEACHING', 'HR']);
    expect(homeSections(['HR_MANAGER', 'TEACHER'])).toEqual(['TEACHING', 'HR']);
  });

  it('never invents a section from a role the person does not hold', () => {
    expect(homeSections(['TEACHER', 'ACCOUNTANT'])).toEqual(['TEACHING']);
    expect(homeSections([])).toEqual([]);
    expect(homeSections(undefined)).toEqual([]);
  });

  it('reads HELD roles only — an Ops deputy does not sprout a teaching section', () => {
    // ⚠️ OPERATIONS_ADMIN satisfies six lower roles by hierarchy (`rolesSatisfying`). If this ever
    // switched to `effectiveRoles`, a deputy's home would claim she teaches — a statement about her
    // JOB, not her permissions. Same rule as `roleLabels`.
    expect(homeSections(['OPERATIONS_ADMIN'])).toEqual([]);
    expect(roleLabels(['OPERATIONS_ADMIN'])).toEqual(['Ops Admin']);
  });
});

describe('roleLabels — every hat, in human words', () => {
  it('names all of them, most-privileged first', () => {
    expect(roleLabels(['TEACHER', 'ADMISSION_CONTROLLER', 'HR_MANAGER']))
      .toEqual(['Admission Controller', 'HR Manager', 'Teacher']);
  });

  it('calls the admission role a job, not a screen', () => {
    // Its `label` is "Admission Portal" — the screen it lands on. A chip reading that would be
    // telling her that her job is a page, which is why the role carries a separate `title`.
    expect(roleLabels(['ADMISSION_CONTROLLER'])).toEqual(['Admission Controller']);
  });

  it('prettifies an unknown role rather than dropping it', () => {
    // A role missing from the one place that states your identity is worse than an imperfect label.
    expect(roleLabels(['TEACHER', 'SOME_FUTURE_ROLE'])).toEqual(['Teacher', 'Some Future Role']);
  });
});

/**
 * Phase 3 — the person who does not teach.
 *
 * A plain staff member (office assistant, driver, lab attendant) had **no home at all**: `/home` was
 * TEACHER-only, so they landed straight in `/my-attendance`, a records screen. Giving them a home
 * and giving them the personal shell had to be ONE decision — `/home` is `hidden` in `NAV`, so on
 * the admin sidebar it renders nowhere and they would have landed on a screen with no link back.
 */
describe('plain staff get a home of their own', () => {
  it('is narrow: only someone with NOTHING but STAFF qualifies', () => {
    expect(isPlainStaff(['STAFF'])).toBe(true);
    // ⚠️ These people have a job and a dashboard already. Sweeping them in would flip their shell
    // and their landing page — a regression for people working fine today.
    expect(isPlainStaff(['STAFF', 'ACCOUNTANT'])).toBe(false);
    expect(isPlainStaff(['STAFF', 'TEACHER'])).toBe(false);
    expect(isPlainStaff(['STAFF', 'HR_MANAGER'])).toBe(false);
    expect(isPlainStaff(['TEACHER'])).toBe(false);
  });

  it('gives them the personal shell, and leaves everyone else’s shell alone', () => {
    expect(usesPersonalShell(['STAFF'])).toBe(true);
    expect(usesPersonalShell(['TEACHER'])).toBe(true);
    expect(usesPersonalShell(['OWNER_ADMIN'])).toBe(false);
    expect(usesPersonalShell(['ACCOUNTANT'])).toBe(false);
    // Holds STAFF but also a job → keeps the administrator's grouped sidebar.
    expect(usesPersonalShell(['STAFF', 'ACCOUNTANT'])).toBe(false);
  });

  it('starts their day on Home, not in a records screen', () => {
    expect(canReach(['STAFF'], '/home')).toBe(true);
    expect(landingPath(['STAFF'])).toBe('/home');
    // ⚠️ The brand must still say Staff. `panelLabel` keys off `usesTeacherShell`, which Phase 3
    // deliberately did NOT widen — else a driver's sidebar would call him a Teacher.
    expect(panelLabel(['STAFF'])).toBe('Staff');
  });

  it('shows them their own day, and a teacher-who-is-also-staff both jobs in order', () => {
    expect(homeSections(['STAFF'])).toEqual(['MY_DAY']);
    // Teaching still leads: the register closes today, the payslip does not.
    expect(homeSections(['STAFF', 'TEACHER'])).toEqual(['TEACHING', 'MY_DAY']);
  });
});

/**
 * Phase 2 — the admin-shell roles that had no dashboard at all.
 *
 * `/dashboard` is `@Roles('OWNER_ADMIN','CAMPUS_ADMIN','ACCOUNTANT')` on the API, so an Admission
 * Controller and an HR Manager could not open it: they dropped straight into a work screen with no
 * overview of any kind. They keep the administrator's grouped sidebar (they have a real job with
 * many screens), so they get an explicit Home entry in it rather than the personal rail.
 */
describe('the roles with no dashboard get a home instead', () => {
  it('offers Home only to people who have no dashboard of their own', () => {
    expect(needsHomeLink(['ADMISSION_CONTROLLER'])).toBe(true);
    expect(needsHomeLink(['HR_MANAGER'])).toBe(true);
    // ⚠️ These already have `/dashboard`; a second front door would compete with it.
    expect(needsHomeLink(['OWNER_ADMIN'])).toBe(false);
    expect(needsHomeLink(['CAMPUS_ADMIN'])).toBe(false);
    expect(needsHomeLink(['ACCOUNTANT'])).toBe(false);
    // The Ops deputy reaches `/dashboard` through the role hierarchy, so it has one too.
    expect(needsHomeLink(['OPERATIONS_ADMIN'])).toBe(false);
  });

  it('lands them on that home rather than cold in a work screen', () => {
    expect(landingPath(['ADMISSION_CONTROLLER'])).toBe('/home');
    expect(landingPath(['HR_MANAGER'])).toBe('/home');
    // Unchanged for everyone who already had a dashboard.
    expect(landingPath(['OWNER_ADMIN'])).toBe('/dashboard');
    expect(landingPath(['ACCOUNTANT'])).toBe('/dashboard');
  });

  it('gives them the section Phase 1 already built, and no teaching', () => {
    expect(homeSections(['ADMISSION_CONTROLLER'])).toEqual(['ADMISSIONS']);
    expect(homeSections(['HR_MANAGER'])).toEqual(['HR']);
    // They keep the grouped admin sidebar — the personal rail is for teachers and plain staff.
    expect(usesPersonalShell(['ADMISSION_CONTROLLER'])).toBe(false);
    expect(usesPersonalShell(['HR_MANAGER'])).toBe(false);
  });
});
