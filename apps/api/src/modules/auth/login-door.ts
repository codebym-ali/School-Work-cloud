import { Role } from '@prisma/client';

/**
 * Sign-in entrances.
 *
 * `owner` → `/owner-login` · `staff` → `/login` · `parent` → `/parent-login`.
 * Students have their own credential entirely (registration number + CNIC) and never reach this rule.
 */
export type LoginDoor = 'staff' | 'owner' | 'parent';

/**
 * May these roles use this door?
 *
 * ⚠️ **Holding `OWNER_ADMIN` routes you to the owner door, whatever else you hold.** The tempting
 * alternative — "allowed at the staff door if they also hold a staff role" — is a bypass: an owner
 * keeps `/login` simply by being granted a second role, and the boundary evaporates. This matches
 * `usesTeacherShell()` on the web side, which already excludes anyone with `OWNER_ADMIN` from the
 * teacher app for the same reason.
 */
export function doorAllows(door: LoginDoor, roles: readonly Role[]): boolean {
  const isOwner = roles.includes(Role.OWNER_ADMIN);
  const isParent = roles.includes(Role.PARENT);
  if (door === 'owner') return isOwner;
  if (door === 'parent') return isParent && !isOwner;

  // ⚠️ **The staff door refuses owners (O2) and parents.** Owners are routed to the owner door;
  // parents are routed to the parent door. Without these refusals, the separation is a label.
  return !isOwner && !isParent;
}
