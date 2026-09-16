import { FEE_ADVANCE_ROLES, FEE_REVERSE_WAIVE_ROLES, hasAnyRole } from './index';

/**
 * The fee-correction buttons must render for exactly the roles the API accepts (GAP-01).
 *
 * Expected values are copied from the API's `@Roles` and its one role hierarchy (OPERATIONS_ADMIN
 * satisfies roles BELOW it, never OWNER_ADMIN) — not derived from the UI constants, or this would only
 * prove the constants agree with themselves.
 */
describe('fee correction permissions mirror the API', () => {
  const cases: Array<[role: string, reverseWaive: boolean, advance: boolean]> = [
    ['OWNER_ADMIN', true, true],
    ['OPERATIONS_ADMIN', true, true], // named on reverse/waive; reaches ACCOUNTANT (advances) by hierarchy
    ['ACCOUNTANT', false, true],      // collects and deposits — never corrects
    ['CAMPUS_ADMIN', false, false],
    ['HR_MANAGER', false, false],
    ['ADMISSION_CONTROLLER', false, false],
    ['TEACHER', false, false],
    ['STAFF', false, false],
  ];

  it.each(cases)('%s: reverse/waive=%s, record advance=%s', (role, reverseWaive, advance) => {
    expect(hasAnyRole([role], FEE_REVERSE_WAIVE_ROLES)).toBe(reverseWaive);
    expect(hasAnyRole([role], FEE_ADVANCE_ROLES)).toBe(advance);
  });

  it('shows nothing to a session with no roles', () => {
    expect(hasAnyRole([], FEE_REVERSE_WAIVE_ROLES)).toBe(false);
    expect(hasAnyRole(undefined, FEE_ADVANCE_ROLES)).toBe(false);
  });
});
