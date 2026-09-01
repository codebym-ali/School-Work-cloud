'use client';

import { createContext, useContext } from 'react';
import type { Campus } from '@sw/api-client';

/**
 * The campus a director is currently looking through — one lens, in the shell, read by every
 * screen instead of each screen holding its own campus `<select>`.
 *
 * ⚠️ **A convenience, never a boundary.** The server already decides campus scope:
 * `effectiveCampusFilter` honours an OWNER's chosen campus and force-ignores a campus-bound user's,
 * so a tampered lens value changes nothing. This context only spares a multi-campus director from
 * re-picking the branch on every screen — the daily motion of a Boys-Campus / Girls-Campus school.
 *
 * `campusId === null` means **all campuses** (the director's whole-school view). For a campus-bound
 * user it is fixed to their own campus and `canChoose` is false, so no control ever shows them a
 * choice they cannot make.
 */
export interface CampusLens {
  /** The active campus, or `null` = all campuses. */
  campusId: string | null;
  /** Campuses the owner may switch between (empty for non-owners — they never choose). */
  campuses: Campus[];
  /** True only for an owner with more than one campus; the only case the shell shows a control. */
  canChoose: boolean;
  /** Set the lens. A no-op unless `canChoose`. */
  setCampus: (id: string | null) => void;
}

export const CampusLensContext = createContext<CampusLens>({
  campusId: null,
  campuses: [],
  canChoose: false,
  setCampus: () => {},
});

export const useCampusLens = (): CampusLens => useContext(CampusLensContext);

/** localStorage key for the persisted branch — a director lives in one branch for a stretch. */
export const CAMPUS_LENS_KEY = 'campusLens';
