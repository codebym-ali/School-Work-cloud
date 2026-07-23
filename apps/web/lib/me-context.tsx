'use client';

import { createContext, useContext } from 'react';
import type { Me } from './api';

/** The signed-in principal, provided by the app layout and read by any client screen. */
export const MeContext = createContext<Me | null>(null);

export const useMe = (): Me | null => useContext(MeContext);

/** True if the signed-in user may use a module (owners/campus-admins get all; a specialist
 *  gets the catalog minus their switched-off modules). Cosmetic gating only — the API 403s
 *  regardless, so a stale value can never grant real access. */
export function hasModule(me: Me | null, key: string): boolean {
  return !!me && (me.modules?.includes(key) ?? false);
}
