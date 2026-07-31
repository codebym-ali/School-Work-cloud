import { HttpStatus } from '@nestjs/common';
import { AppError } from '../errors/app.error';
import { ErrorCodes } from '../errors/error-codes';
import type { RequestUser } from '../context/tenant-context';

/**
 * Campus scoping for multi-campus tenants (blueprint §22.8, security playbook P1.7).
 *
 * Non-OWNER_ADMIN roles are confined to their own campus: the service must FORCE the
 * campus filter on reads/lists (never trust a client-supplied `campusId`) and 403 on any
 * resource whose campus differs. This lives in services, not a guard — guards run before
 * the `withTenant` tx, so they cannot read the tenant rows an ownership/campus check needs.
 */

/**
 * The nil UUID — syntactically valid but no real campus (random UUIDs) will ever equal it.
 * Used as the fail-closed sentinel: a campus-restricted principal with a null `campusId`
 * (a misconfiguration) is restricted to THIS campus, which matches nothing → deny-by-default,
 * rather than silently falling through to school-wide access.
 */
export const NO_CAMPUS = '00000000-0000-0000-0000-000000000000';

/**
 * The campus a principal is confined to, or `null` when it is school-wide.
 * - OWNER_ADMIN → `null` (no restriction).
 * - Any other role → its own `campusId`; a null `campusId` (misconfig) → `NO_CAMPUS` (deny).
 * - No principal at all → `NO_CAMPUS` (deny).
 *
 * ADMISSION_CONTROLLER used to be special-cased here: no campus binding meant *school-wide*,
 * so it could admit into every campus. That made a campus-less grant silently hand over the
 * whole school. An admission officer is now a per-campus seat (exactly one per campus, campus
 * required — see UsersService), so the special case is gone and a campus-less AC fails closed
 * like everyone else. Defence in depth: even a legacy row with no campus is denied, not widened.
 */
export function restrictedCampusId(user: RequestUser | undefined): string | null {
  if (!user) return NO_CAMPUS;
  if (user.roles.includes('OWNER_ADMIN')) return null;
  return user.campusId ?? NO_CAMPUS;
}

/**
 * Resolve the effective campus filter for a list/read: the forced restriction when the
 * principal is campus-bound, else the (trusted-only-for-school-wide-admins) client value.
 */
export function effectiveCampusFilter(
  user: RequestUser | undefined,
  clientCampusId: string | undefined,
): string | undefined {
  const restricted = restrictedCampusId(user);
  return restricted ?? clientCampusId;
}

/** Throw 403 FORBIDDEN unless `campusId` is within the principal's restriction. */
export function assertCampusAccess(user: RequestUser | undefined, campusId: string | null | undefined): void {
  const restricted = restrictedCampusId(user);
  if (restricted === null) return; // school-wide principal
  if (campusId !== restricted) {
    throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Resource belongs to another campus');
  }
}
