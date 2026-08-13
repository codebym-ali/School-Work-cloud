import { Role } from '@prisma/client';

/**
 * The two staff-facing sign-in entrances (Owner Login Plan).
 *
 * `owner` → `/owner-login` · `staff` → `/login`. Students have their own credential entirely
 * (registration number + CNIC) and never reach this rule.
 */
export type LoginDoor = 'staff' | 'owner';

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
  if (door === 'owner') return isOwner;

  // ⚠️ **The staff door still admits owners — for now, and only until O2.**
  //
  // O0/O1 ship the owner's entrance without disturbing anything: `/owner-login` is owner-only from
  // the moment it exists, while `/login` keeps working for everybody, so no existing session, test
  // or seed script changes. That makes the separation real in one direction only.
  //
  // O2 closes it by returning `!isOwner` here — one line — and that is the change that makes the
  // two doors mutually exclusive. It is deliberately a separate phase because it also stops
  // `owner@demo.pk` working at `/login`, and rewrites the ~37 test files that sign in as an owner.
  return true;
}
