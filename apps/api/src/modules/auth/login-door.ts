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

  // ⚠️ **The staff door refuses owners (O2).** This is the half that makes the two doors mutually
  // exclusive; without it the owner simply had a second entrance and the separation was a label.
  //
  // The refusal is delivered by the caller as the same `invalid()` a wrong password produces, doing
  // the same work — otherwise this line would turn `/login` into an owner-detector, leaking which
  // address owns the school, which is precisely the leak the owner door exists to prevent.
  return !isOwner;
}
