import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

/**
 * Roles for which two-factor is MANDATORY — the accounts that can move money or reach every
 * student's identity data. Shared by login (which reports `mfaEnrollmentRequired`) and by
 * `MfaEnrolledGuard` (which enforces it), so the two can never disagree about who is covered.
 */
export const MANDATORY_MFA_ROLES: readonly Role[] = [Role.OWNER_ADMIN, Role.OPERATIONS_ADMIN, Role.ACCOUNTANT];

export const REQUIRES_MFA_KEY = 'requiresMfa';

/**
 * Marks a route as SENSITIVE: a caller holding a mandatory-MFA role must be enrolled to use it.
 *
 * ⚠️ **Deliberately applied to corrections and disclosures, not to routine work** (Decision D1).
 * Reversing a payment, waiving an invoice, revealing a CNIC, approving payroll and changing who
 * holds which role are marked. Collecting a fee is NOT: gating the counter would stop an unenrolled
 * accountant taking money on the morning this ships, which is a worse outcome than the risk it
 * addresses. The line is "undoes or discloses", not "touches money".
 */
export const RequiresMfa = () => SetMetadata(REQUIRES_MFA_KEY, true);
