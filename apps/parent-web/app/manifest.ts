import type { MetadataRoute } from 'next';

/**
 * Web app manifest for the **Parent portal**.
 *
 * Same restoration as `staff-web`: installability shipped in `apps/web` (Teacher Mobile Home Plan,
 * M4) and did not follow the screens when the front-end split moved them onto their own origins.
 *
 * A parent checking attendance, results or what is owed is doing it on a phone, so this belongs on
 * a home screen beside the staff app rather than behind a browser tab. `short_name` is what the
 * launcher shows under the icon, so it says **Parent** where the staff app says **Staff** — the two
 * are installed side by side on a parent's phone.
 *
 * **No service worker**, for the same reason as the other apps: no offline requirement, and nothing
 * that can serve a stale build after a deploy. Chrome therefore never offers the install; it is
 * always "Add to Home Screen".
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Parent Portal',
    short_name: 'Parent',
    description: 'Your attendance, timetable, results and fees',
    // The portal's dashboard already lives at the root of this app, so `/` is a real screen here —
    // unlike staff-web, which needed a root page adding for exactly this reason.
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#eef2f8', // --bg
    theme_color: '#17365c',      // --brand
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
