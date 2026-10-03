import { Role } from '@prisma/client';

/**
 * The three sign-in entrances: owner, staff, parent.
 */
export type LoginDoor = 'staff' | 'owner' | 'parent';

/**
 * May these roles use this door?
 *
 * Three doors, mutually exclusive: owner gets `/owner-login`, parents get `/portal/auth/login`,
 * staff get `/login`. A PARENT at the staff door or an OWNER at the staff door → same generic
 * rejection (no information leak).
 */
export function doorAllows(door: LoginDoor, roles: readonly Role[]): boolean {
  const isOwner = roles.includes(Role.OWNER_ADMIN);
  const isParent = roles.includes(Role.PARENT);

  if (door === 'owner') return isOwner;
  if (door === 'parent') return isParent;

  // Staff door: refuses owners AND parents.
  return !isOwner && !isParent;
}
