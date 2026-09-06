import type { MetadataRoute } from 'next';

/**
 * Web app manifest for the **Staff** app (restored 2026-09-06).
 *
 * ⚠️ **The front-end split silently un-installed this app.** Installability shipped with the Teacher
 * Mobile Home Plan (M4) and lived in `apps/web` — and when the split moved the school screens out to
 * `owner-web`/`staff-web`, the manifest and icons stayed behind on the marketing app. Nothing failed:
 * `apps/web` still served a perfectly good manifest for a site nobody installs, while the
 * **phone-first app the feature was built for** could no longer be added to a home screen at all.
 * `installable.spec` did not catch it because it was still pointed at `apps/web`. That is the shape
 * of bug the split's route-coverage gate exists for, one layer down: the capability moved apps and
 * its assets did not follow.
 *
 * A teacher walking between rooms is the whole audience here — this is the one app that has to open
 * from an icon beside WhatsApp, full screen, with no address bar.
 *
 * **Still no service worker**, deliberately, exactly as in the original: offline register marking is
 * out of scope, and without a service worker an installed window cannot serve a stale build after a
 * deploy. The price is that Chrome will never *offer* the install (`beforeinstallprompt` needs a
 * `fetch()` handler) — staff have to be told to use "Add to Home Screen". See `apps/web/app/manifest.ts`
 * for the full reasoning; if that decision is ever revisited it must be revisited in both places.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'School Staff',
    short_name: 'Staff',
    description: 'Attendance, timetable, leave and payslips for teachers and staff',
    /**
     * ⚠️ **`/` had to be MADE to work for this.** staff-web had no root page, so the bare origin
     * 404'd — an installed app would have opened on "This page could not be found", and in
     * production `staff.<school>.schoolworks.com` did the same. `app/page.tsx` now sends the visitor
     * to their own landing (`landingPath`), or to the door when signed out, so this entry point is
     * correct for every role the app serves rather than for one of them.
     *
     * Relative on purpose: each school is its own subdomain, so an absolute URL here would point
     * every tenant's installed icon at whichever school was hardcoded.
     */
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    // Mirrors `--bg` and `--brand` by hand — the manifest is TS and cannot read a CSS custom
    // property. If the brand moves, it moves in globals.css, layout.tsx `themeColor`, and here.
    background_color: '#eef2f8', // --bg, so the splash matches the first paint
    theme_color: '#17365c',      // --brand
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // Maskable: Android crops to the launcher's shape, and an icon without a safe margin loses
      // its edges. These are drawn with that padding.
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
