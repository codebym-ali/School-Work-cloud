import { HttpStatus } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AppError } from '../errors/app.error';
import { ErrorCodes } from '../errors/error-codes';
import type { RequestUser } from '../context/tenant-context';

/**
 * Refuse a precondition OVERRIDE unless the caller holds OWNER_ADMIN.
 *
 * ⚠️ **Why a separate check exists at all.** An override flag rides inside a request body on a route
 * that more than one role may call. `@Roles` admits the route; it cannot see the flag. So an override
 * documented as owner-only is enforced for nobody unless the service checks it — which is exactly
 * what had happened twice:
 *   - `PromoteDto.overridePreconditions` — "OWNER_ADMIN: bypass fee-clearance" — on a route open to
 *     CAMPUS_ADMIN, with no role check in `promote()`;
 *   - `WithdrawDto.overrideFeeClearance` — the same, on the withdrawal route.
 * A campus admin could promote a student the school's own setting said must clear fees first.
 *
 * ⚠️ `user.roles` holds the roles a user was GRANTED, not the hierarchy-expanded set, and the only
 * hierarchy (`rolesSatisfying`) never adds OWNER_ADMIN. So OPERATIONS_ADMIN — the owner's deputy —
 * cannot override. That is intended: an override bypasses a financial control, and the deputy is
 * precisely the role that control is meant to hold.
 *
 * A request that does not ask for the override is always allowed through; this guards the flag,
 * not the operation.
 */
export function assertOwnerOverride(user: RequestUser | undefined, requested: boolean | undefined, what: string): void {
  if (!requested) return;
  if (user?.roles.includes(Role.OWNER_ADMIN)) return;
  throw new AppError(
    ErrorCodes.FORBIDDEN,
    HttpStatus.FORBIDDEN,
    `Only the school owner can override ${what}.`,
  );
}
