'use client';

import { createContext, useContext } from 'react';
import type { PlatformUser } from '@/lib/platform-api';

/**
 * The signed-in operator, resolved ONCE by the admin layout's `/platform/auth/me` call and shared
 * down the tree — mirrors the tenant app's `me-context`. Role-gated controls (provision / suspend /
 * reactivate) and the Security area both read `role`/`mfaEnabled` from here rather than each
 * re-fetching `me`, so there is a single source of truth for who is looking at the console.
 */
export const PlatformMeContext = createContext<PlatformUser | null>(null);

/** The operator for the current console session. Throws if used outside the admin shell (the
 *  layout only mounts children once `me` has resolved, so within the shell it is never null). */
export function usePlatformMe(): PlatformUser {
  const me = useContext(PlatformMeContext);
  if (!me) throw new Error('usePlatformMe must be used within the admin shell');
  return me;
}
