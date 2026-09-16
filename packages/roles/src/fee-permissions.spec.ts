import {
  FEE_ADVANCE_ROLES, FEE_CLEARANCE_OVERRIDE_ROLES, FEE_REVERSE_WAIVE_ROLES, GUARDIAN_ADD_ROLES, GUARDIAN_EDIT_ROLES,
  hasAnyRole, ISSUED_DOCUMENT_ROLES, WITHDRAW_ROLES,
} from './index';

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

describe('guardian permissions mirror the API', () => {
  // From students.controller.ts: add = OWNER_ADMIN, CAMPUS_ADMIN, ADMISSION_CONTROLLER;
  // edit / primary / remove / verify = OWNER_ADMIN, CAMPUS_ADMIN. The deputy satisfies both by hierarchy.
  const cases: Array<[role: string, add: boolean, edit: boolean]> = [
    ['OWNER_ADMIN', true, true],
    ['OPERATIONS_ADMIN', true, true],
    ['CAMPUS_ADMIN', true, true],
    ['ADMISSION_CONTROLLER', true, false], // may finish a record it started; may not rewrite a guardian
    ['ACCOUNTANT', false, false],
    ['HR_MANAGER', false, false],
    ['TEACHER', false, false],
    ['STAFF', false, false],
  ];

  it.each(cases)('%s: add=%s, edit=%s', (role, add, edit) => {
    expect(hasAnyRole([role], GUARDIAN_ADD_ROLES)).toBe(add);
    expect(hasAnyRole([role], GUARDIAN_EDIT_ROLES)).toBe(edit);
  });
});

describe('leaving and certificate permissions mirror the API', () => {
  // documents.controller.ts: withdraw / issue / read = OWNER_ADMIN, CAMPUS_ADMIN (deputy by hierarchy).
  // The fee-clearance OVERRIDE checks the GRANTED role in the service, so the deputy may withdraw but not override.
  const cases: Array<[role: string, withdraw: boolean, override: boolean]> = [
    ['OWNER_ADMIN', true, true],
    ['OPERATIONS_ADMIN', true, false],
    ['CAMPUS_ADMIN', true, false],
    ['ACCOUNTANT', false, false],
    ['ADMISSION_CONTROLLER', false, false],
    ['TEACHER', false, false],
  ];

  it.each(cases)('%s: withdraw/documents=%s, override fee clearance=%s', (role, withdraw, override) => {
    expect(hasAnyRole([role], WITHDRAW_ROLES)).toBe(withdraw);
    expect(hasAnyRole([role], ISSUED_DOCUMENT_ROLES)).toBe(withdraw);
    expect(hasAnyRole([role], FEE_CLEARANCE_OVERRIDE_ROLES)).toBe(override);
  });
});
