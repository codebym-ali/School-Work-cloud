'use client';

import { useEffect, useState } from 'react';

/**
 * The phone breakpoint, in one place.
 *
 * ⚠️ **`globals.css` uses `720px` in its media queries and must match this.** A breakpoint that
 * disagrees between CSS and JS produces the worst kind of layout bug: correct at every width
 * except a narrow band, where the tab bar is showing but the component still thinks it is on a
 * desktop. Change one, change the other.
 */
export const PHONE_MAX_WIDTH = 720;

/**
 * True when the viewport is phone-width.
 *
 * Used **only** where the difference is structural rather than cosmetic — a week grid becoming a
 * day-at-a-time view needs different markup, not different padding. Anything CSS can do alone
 * should stay in CSS: a media query costs nothing and survives with JavaScript disabled, while
 * this re-renders.
 *
 * Starts `false` and corrects after mount, because the server has no viewport. That means the
 * first paint is the desktop shape; for a grid that then collapses this is unnoticeable, and the
 * alternative — guessing from a user-agent string — is wrong often enough to be worse.
 */
export function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${PHONE_MAX_WIDTH}px)`);
    const sync = () => setIsPhone(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  return isPhone;
}
