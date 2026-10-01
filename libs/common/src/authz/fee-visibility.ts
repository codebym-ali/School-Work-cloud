import { HttpStatus } from '@nestjs/common';
import { AppError } from '../errors/app.error';
import { ErrorCodes } from '../errors/error-codes';
import { parseSchoolSettings } from '../config/school-settings.schema';
import type { RequestUser } from '../context/tenant-context';

/**
 * Fee visibility for the campus admin — the owner's choice (`campusAdminSeesFees` school setting).
 *
 * A person is "campus-admin-only" for money when they hold CAMPUS_ADMIN and none of the roles that run
 * or oversee money: OWNER_ADMIN, ACCOUNTANT, OPERATIONS_ADMIN. `user.roles` are the GRANTED roles (not the
 * hierarchy-expanded set), so an Ops Admin — who covers CAMPUS_ADMIN — is correctly not caught here.
 *
 * Lives in the service layer, not a guard: guards run before the tenant transaction, where the school's
 * settings would read as zero rows under RLS.
 */
export function isCampusAdminOnlyForMoney(user: RequestUser | undefined): boolean {
  const roles = user?.roles ?? [];
  return roles.includes('CAMPUS_ADMIN')
    && !roles.includes('OWNER_ADMIN')
    && !roles.includes('ACCOUNTANT')
    && !roles.includes('OPERATIONS_ADMIN');
}

/** True when this caller must not see fee information at this school. `loadSettings` returns the raw
 *  `School.settings` blob and is only called when the answer depends on it. */
export async function feesHiddenFromActor(user: RequestUser | undefined, loadSettings: () => Promise<unknown>): Promise<boolean> {
  if (!isCampusAdminOnlyForMoney(user)) return false;
  return !parseSchoolSettings(await loadSettings()).campusAdminSeesFees;
}

/** Throw 403 when the owner has chosen not to show fees to campus admins. */
export async function assertMayReadFees(user: RequestUser | undefined, loadSettings: () => Promise<unknown>): Promise<void> {
  if (await feesHiddenFromActor(user, loadSettings)) {
    throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'The school owner has chosen not to share fee information with campus admins');
  }
}
