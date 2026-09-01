/**
 * The app's icon set — inline SVG, drawn on `currentColor`.
 *
 * ⚠️ **This exists because the app had NO icons, only emoji.** An emoji is a text glyph the
 * operating system paints in its own fixed, multi-colour way: it cannot inherit `currentColor`,
 * so it cannot be brand-tinted, cannot go white on a navy header, cannot dim when disabled, and
 * renders as a different picture on Windows, macOS, Android and iOS. That is why the icons read
 * as "random" against a deliberate palette — they were never part of it and could not be.
 *
 * Everything here is one shape language so the set reads as a set:
 *   · 24×24 box, geometry on a 20px core with 2px of optical padding
 *   · `stroke="currentColor"`, `fill="none"`, **1.75** stroke, round caps and joins
 *   · no internal colour, ever — colour comes from the CSS that contains it
 *
 * The stroke weight is deliberately NOT scaled with the rendered size. These are used at 16–20px,
 * where a hairline disappears and a 2px stroke turns a 24px glyph into a blob; 1.75 holds at both.
 */

// The IconName type moved to the shared `@sw/ui` package (Phase 0) so `@sw/roles` can type nav items
// without pulling in React. Re-exported here so `@/components/icon` still exports it app-wide.
import type { IconName } from './icon-name';

/**
 * Paths only — every icon shares one `<svg>` wrapper below, so the box, stroke and colour
 * behaviour cannot drift between them. A new icon adds a path here and a name above; it cannot
 * accidentally introduce its own viewBox or a hard-coded fill.
 */
const PATHS: Record<IconName, React.ReactNode> = {
  dashboard: <><rect x="3" y="3" width="7.5" height="8.5" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="5" rx="1.5" /><rect x="13.5" y="11" width="7.5" height="10" rx="1.5" /><rect x="3" y="14.5" width="7.5" height="6.5" rx="1.5" /></>,
  admissions: <><path d="M15.5 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V6.5Z" /><path d="M15 3v3.5h4" /><path d="M8.5 13h7M8.5 16.5h4.5" /></>,
  'admissions-team': <><path d="M12 3 2.5 8 12 13l9.5-5Z" /><path d="M6.5 10.2v5.1c0 .5.3 1 .8 1.2a11 11 0 0 0 9.4 0c.5-.2.8-.7.8-1.2v-5.1" /><path d="M21.5 8v5.5" /></>,
  students: <><circle cx="9" cy="8" r="3.2" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M16.5 5.4a3.2 3.2 0 0 1 0 6.2" /><path d="M17.5 14.6A6 6 0 0 1 21 20" /></>,
  classes: <><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 0 4 20.5Z" /><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v15h5.5a1.5 1.5 0 0 1 1.5 1.5Z" /></>,
  attendance: <><rect x="3" y="4.5" width="18" height="16.5" rx="2" /><path d="M3 9.5h18" /><path d="M8 3v3M16 3v3" /><path d="m8.5 14.5 2.3 2.3 4.4-4.4" /></>,
  leaves: <><rect x="3" y="4.5" width="18" height="16.5" rx="2" /><path d="M3 9.5h18" /><path d="M8 3v3M16 3v3" /><path d="M12 12.5v5M9.5 15h5" /></>,
  timetable: <><circle cx="12" cy="12" r="9" /><path d="M12 6.8V12l3.4 2" /></>,
  // A day as a strip of rows with a time column down the left — deliberately NOT another clock,
  // since `timetable` already owns that shape and these two sit next to each other in the nav.
  timings: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9.5h18M3 15h18" /><path d="M8 4v16" /></>,
  cover: <><path d="M3.5 9A8.5 8.5 0 0 1 18 6.2l2.5 2.3" /><path d="M20.5 4v4.5H16" /><path d="M20.5 15A8.5 8.5 0 0 1 6 17.8L3.5 15.5" /><path d="M3.5 20v-4.5H8" /></>,
  exams: <><path d="M15.5 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V6.5Z" /><path d="M15 3v3.5h4" /><path d="m8.5 14 2 2 3.5-3.5" /></>,
  reports: <><path d="M3 20.5h18" /><rect x="4.5" y="11" width="4" height="7" rx="1" /><rect x="10" y="6.5" width="4" height="11.5" rx="1" /><rect x="15.5" y="14" width="4" height="4" rx="1" /></>,
  performance: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" /></>,
  fees: <><rect x="2.5" y="5" width="19" height="14" rx="2.5" /><path d="M2.5 10h19" /><path d="M6.5 14.8h3.5" /></>,
  'fee-claims': <><path d="M5 3.8v16.4l2.3-1.4 2.3 1.4 2.4-1.4 2.4 1.4 2.3-1.4 2.3 1.4V3.8L16.7 5.2 14.4 3.8 12 5.2 9.6 3.8 7.3 5.2Z" /><path d="M8.5 9.5h7M8.5 13.5h4.5" /></>,
  staff: <><circle cx="12" cy="7.5" r="3.5" /><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" /></>,
  setup: <><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /><path d="M19.1 14.4a1.6 1.6 0 0 0 .3 1.8l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a1.9 1.9 0 1 1-3.8 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1h-.2a1.9 1.9 0 1 1 0-3.8h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5v-.2a1.9 1.9 0 1 1 3.8 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1h.2a1.9 1.9 0 1 1 0 3.8h-.1a1.6 1.6 0 0 0-1.5 1Z" /></>,
  settings: <><path d="M6 3v6M6 13v8M12 3v10M12 17v4M18 3v3M18 10v11" /><circle cx="6" cy="11" r="2" /><circle cx="12" cy="15" r="2" /><circle cx="18" cy="8" r="2" /></>,
  campuses: <><path d="M3 21h18" /><path d="M4.5 21V6.5L12 3l7.5 3.5V21" /><path d="M9.5 21v-5h5v5" /><path d="M9 10h1.5M13.5 10H15" /></>,
  calendar: <><rect x="3" y="4.5" width="18" height="16.5" rx="2" /><path d="M3 9.5h18" /><path d="M8 3v3M16 3v3" /></>,
  home: <><path d="M3.5 10.5 12 3.5l8.5 7" /><path d="M5.5 9v11h13V9" /><path d="M9.75 20v-6h4.5v6" /></>,
  profile: <><circle cx="12" cy="8" r="4" /><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" /></>,
  payslips: <><rect x="2.5" y="6" width="19" height="12" rx="2" /><circle cx="12" cy="12" r="2.75" /><path d="M6 9.5v5M18 9.5v5" /></>,
  lock: <><rect x="4.5" y="10" width="15" height="10.5" rx="2" /><path d="M8 10V7.5a4 4 0 0 1 8 0V10" /></>,
  school: <><path d="M3 21h18" /><path d="M12 3 3.5 7.5V21h17V7.5Z" /><path d="M9.5 21v-5.5h5V21" /><path d="M12 7.5v3" /></>,
  alert: <><path d="M12 3.8 2.8 19.5h18.4Z" /><path d="M12 10v4" /><circle cx="12" cy="17" r=".6" fill="currentColor" /></>,
  message: <><rect x="2.5" y="5" width="19" height="14" rx="2.5" /><path d="m3.5 7 7.4 5.3a2 2 0 0 0 2.2 0L20.5 7" /></>,
  bell: <><path d="M18 8.5a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5" /><path d="M13.7 19a2 2 0 0 1-3.4 0" /></>,
  'chevron-right': <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />,
  'trend-up': <><path d="M3.5 17 9.5 11l3.5 3.5L20.5 7" /><path d="M15.5 7h5v5" /></>,
  'check-circle': <><circle cx="12" cy="12" r="9" /><path d="m8 12.2 2.6 2.6L16 9.4" /></>,
  'x-circle': <><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></>,
  // A person stepping away, not a palm tree: leave is an absence with permission, and the
  // register reads it beside "absent" and "not marked" rather than beside a holiday.
  leave: <><circle cx="10" cy="7" r="3" /><path d="M3.5 20a6.5 6.5 0 0 1 11.2-4.5" /><path d="M15.5 18.5h6M18.5 15.5l3 3-3 3" /></>,
  unknown: <><circle cx="12" cy="12" r="9" /><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .9-1 1.6v.3" /><circle cx="12" cy="16.8" r=".6" fill="currentColor" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  inbox: <><path d="M3.5 13.5h4l1.3 2.2h6.4l1.3-2.2h4" /><path d="M5.6 5.2 3.5 13.5v3.8a1.7 1.7 0 0 0 1.7 1.7h13.6a1.7 1.7 0 0 0 1.7-1.7v-3.8L18.4 5.2a1.7 1.7 0 0 0-1.6-1.1H7.2a1.7 1.7 0 0 0-1.6 1.1Z" /></>,
};

export interface IconProps {
  name: IconName;
  /** Rendered box in px. The stroke does NOT scale with it — see the note above. */
  size?: number;
  className?: string;
}

/**
 * ⚠️ `aria-hidden` is not a default to be overridden — it is the correct answer everywhere this
 * set is used. Every icon here sits beside its own visible text label (the nav item's name, the
 * panel's title, the tile's caption), so announcing it would make a screen reader read the same
 * thing twice. An icon that ever stands alone needs a real label on the CONTROL, not on the glyph.
 */
export function Icon({ name, size = 18, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
