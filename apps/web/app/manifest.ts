import type { MetadataRoute } from 'next';

/**
 * Web app manifest (Teacher Mobile Home Plan, M4).
 *
 * What this buys: "Add to home screen" gives a real icon beside WhatsApp, launches full screen
 * with no address bar, and appears in the app switcher as its own app. To a teacher it is simply
 * "the school app" — and it needs no app store, no review, and no separate Android and iOS builds.
 * Deploy the site and everyone has the new version.
 *
 * **There is deliberately no service worker.** That is the decision, not an omission:
 *  - offline attendance marking is out of scope (plan §8) — a local queue would need conflict
 *    rules for a register the office may have marked meanwhile, and attendance feeds pay;
 *  - without a service worker nothing caches the app shell, so an installed window cannot serve
 *    yesterday's build after a deploy. The stale-version risk that made this phase worth deferring
 *    **comes from the service worker**, and not adding one removes it rather than managing it.
 *
 * If offline is ever wanted, the version-check and "reload" prompt have to arrive in the same
 * change as the service worker, never after it.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'School Management',
    short_name: 'School',
    description: 'Attendance, timetable and leave for teachers and staff',
    // Multi-tenant: each school is its own subdomain, so the scope is relative and the installed
    // app belongs to whichever school it was installed from. A hardcoded absolute URL here would
    // point every tenant's icon at one school.
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f6f7f9', // --bg, so the splash matches the first paint
    theme_color: '#3355cc',      // --brand
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // Maskable: Android crops icons to the launcher's shape, and an icon without a safe margin
      // gets its edges cut off. These are drawn with the padding that expects.
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
