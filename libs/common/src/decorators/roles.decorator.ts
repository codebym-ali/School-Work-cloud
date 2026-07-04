import { SetMetadata } from '@nestjs/common';
import type { Role } from '@prisma/client';

/**
 * Requires the caller to hold at least one of these roles (blueprint §23).
 * Effective permission = union of the user's role grants; scope is enforced
 * separately by the ownership guards (§22.8).
 */
export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
