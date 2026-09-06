import { homeSections, roleLabels } from './index';

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
