import { Role } from '@prisma/client';

/**
 * Every role that belongs to a signed-in SCHOOL STAFF member — i.e. every tenant role EXCEPT the
 * portal role `STUDENT`, the login-less `PARENT`, and the vendor-side `PLATFORM_ADMIN`.
 *
 * Use it on structural reference reads (class / section / subject / campus / academic-year / exam /
 * term / grade-scale lists) that every staff screen legitimately needs, but which a STUDENT portal
 * session must not be able to enumerate. Those reads shipped with no `@Roles` at all, so any
 * authenticated session — a student included — could list the whole school's structure
 * (Tenant Dashboard QA, Issue 3, 2026-08-29). Gating them here closes that without narrowing any
 * staff screen: OPERATIONS_ADMIN is listed explicitly (it also satisfies the lower roles via the
 * hierarchy), and nothing a student's own portal (`/portal/*`) needs is in this set.
 */
export const STAFF_ROLES: Role[] = [
  Role.OWNER_ADMIN,
  Role.OPERATIONS_ADMIN,
  Role.CAMPUS_ADMIN,
  Role.ADMISSION_CONTROLLER,
  Role.HR_MANAGER,
  Role.ACCOUNTANT,
  Role.TEACHER,
  Role.STAFF,
];
