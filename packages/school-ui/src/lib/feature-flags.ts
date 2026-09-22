'use client';

import { useEffect, useState } from 'react';

/**
 * A per-browser feature flag, opt-in and off by default — the light-touch pilot switch the
 * deployment plan calls for before real per-tenant flag infrastructure exists. It lets an in-progress
 * redesign (the owner-home v2) ship to `main` dark: nothing changes for anyone until a reviewer turns
 * it on for their own browser, so the work is reviewable on the live app without a risky cutover.
 *
 * Turn on:  `?ff=ownerHomeV2`   ·   turn off:  `?ff=off`  or  `?ff=-ownerHomeV2`
 * The choice persists in `localStorage`, so it survives navigation without keeping the query string.
 *
 * ⚠️ A convenience, never a boundary — exactly like the campus lens. It gates presentation only; it
 * must never be the thing standing between a user and data the server would otherwise refuse.
 */
export function useFeatureFlag(name: string): boolean {
  const [on, setOn] = useState(false);

  useEffect(() => {
    const key = `ff:${name}`;
    try {
      const ff = new URL(window.location.href).searchParams.get('ff');
      if (ff) {
        for (const token of ff.split(',').map((t) => t.trim())) {
          if (token === 'off' || token === `-${name}`) localStorage.removeItem(key);
          else if (token === name) localStorage.setItem(key, '1');
        }
      }
      setOn(localStorage.getItem(key) === '1');
    } catch {
      // SSR, private mode, or blocked storage: the flag simply stays off.
    }
  }, [name]);

  return on;
}
