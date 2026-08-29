import { Role } from '@prisma/client';

/**
 * Role hierarchy for the `@Roles` gate (Operations Admin Role Plan). The `RolesGuard` is a flat
 * "holds one of the required roles" check; this gives `OPERATIONS_ADMIN` — the owner's operational
 * deputy — a ONE-DIRECTIONAL inheritance: it **satisfies any requirement for a role BELOW it**, but
 * **never `OWNER_ADMIN`**. Consequence, by construction:
 *   - routes gated `@Roles('OWNER_ADMIN', <lower>)` admit Ops (via the lower role);
 *   - routes gated `@Roles('OWNER_ADMIN')` ALONE stay owner-reserved (Ops does not satisfy owner).
 * Every other role satisfies only itself. This is the ONLY hierarchy in the system.
 */
const OPERATIONS_ADMIN_COVERS: readonly Role[] = [
  Role.CAMPUS_ADMIN,
  Role.ADMISSION_CONTROLLER,
  Role.HR_MANAGER,
  Role.ACCOUNTANT,
  Role.TEACHER,
  Role.STAFF,
];

/**
 * Expand the roles a user HOLDS into the set that SATISFIES `@Roles` matching. Only adds the roles an
 * `OPERATIONS_ADMIN` covers — it never adds `OWNER_ADMIN`, so the owner ceiling is absolute.
 */
export function rolesSatisfying(held: readonly Role[]): Set<Role> {
  const set = new Set<Role>(held);
  if (held.includes(Role.OPERATIONS_ADMIN)) {
    for (const r of OPERATIONS_ADMIN_COVERS) set.add(r);
  }
  return set;
}
