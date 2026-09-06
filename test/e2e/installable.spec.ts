import { test, expect } from '@playwright/test';

/**
 * The phone apps are installable to a home screen (Teacher Mobile Home Plan, M4c).
 *
 * **Why this is a test and not a note in a doc.** Every part of installability is a *link that
 * resolves* — a manifest, three icons, an apple-touch-icon — and links rot silently. The icons
 * exist as static PNGs precisely because the generated `app/icon.tsx` route **500s on Windows**
 * (`@vercel/og` cannot load its own font), which would have left every icon a broken link with
 * nothing failing. That is the exact shape of bug this guards.
 *
 * ⚠️ **It rotted anyway, one layer up, and this spec was pointed at the wrong app to see it.** The
 * front-end split moved the school screens onto their own origins and left the manifest and icons
 * behind in `apps/web` — so the marketing site stayed installable while the **phone-first staff app
 * the feature was built for** could not be added to a home screen at all. The spec kept passing
 * against `apps/web`, then failed against `owner-web` when the suite was re-homed, which is how it
 * finally surfaced. It now runs against **the apps that are supposed to be installable**, so
 * "which app is this asserting?" can never drift from "which app do people install?" again.
 *
 * ⚠️ **What is deliberately NOT asserted: an install prompt.** Chrome dropped the service-worker
 * requirement for installing **from the browser menu** (m108 mobile, m112 desktop), which is what
 * makes these apps installable with no service worker at all. But the *automatic* banner —
 * `beforeinstallprompt` — still requires a `fetch()` handler, so Chrome will never volunteer the
 * install. That is a consequence of the no-service-worker decision (M4b), not a defect, and the
 * teacher has to be told to use "Add to Home Screen". Asserting a prompt here would fail forever.
 * iOS Safari has never had a prompt — Add to Home Screen is always manual — so nothing changes there.
 */
const PHONE_APPS = [
  // The staff app is the reason this feature exists: a teacher marking a register between rooms.
  { app: 'staff', baseURL: 'http://localhost:3006', name: 'School Staff', shortName: 'Staff' },
  // Installed beside it — often on the same phone, in a household where a parent carries both.
  { app: 'student', baseURL: 'http://localhost:3003', name: 'Student Portal', shortName: 'Student' },
];

for (const { app, baseURL: origin, name, shortName } of PHONE_APPS) {
  test.describe(`installable — ${app}`, () => {
    // No session needed: the manifest and icons are public, and requiring a login here would make a
    // static-asset check depend on auth.
    test.use({ storageState: { cookies: [], origins: [] }, baseURL: origin });

    test('serves a manifest that meets every documented install criterion', async ({ request, baseURL }) => {
      const res = await request.get(`${baseURL}/manifest.webmanifest`);
      expect(res.status()).toBe(200);
      const m = await res.json();

      // Chrome's documented criteria, each one a thing that silently disables installation.
      expect(m.name).toBe(name);
      // ⚠️ The launcher shows `short_name` under the icon, so the two apps must not both say
      // "School" — a teacher whose phone carries both needs to tell them apart at a glance.
      expect(m.short_name).toBe(shortName);
      expect(m.start_url).toBeTruthy();
      expect(['standalone', 'fullscreen', 'minimal-ui']).toContain(m.display);
      // ≥192 and ≥512 are both required, and a maskable one is what stops Android's launcher
      // cropping the edges off a square icon.
      const sizes = (m.icons as { sizes: string; purpose?: string }[]).map((i) => i.sizes);
      expect(sizes).toContain('192x192');
      expect(sizes).toContain('512x512');
      expect(m.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);

      // ⚠️ **The retheme colours, asserted where they are actually SERVED.** `manifest.ts` copies
      // `--brand` and `--bg` by hand — TypeScript cannot read a CSS custom property — and U0 moved
      // both tokens without moving these, so the installed app wore the previous identity: the old
      // brand on the Android status bar, the old field on the splash. Nothing failed, because the
      // only colour under test was the meta tag. These two lines are the other half.
      expect(m.theme_color, 'manifest theme_color must track --brand').toBe('#17365c');
      expect(m.background_color, 'manifest background_color must track --bg').toBe('#eef2f8');

      // `start_url` and `scope` must stay RELATIVE. Each school is its own subdomain, so an absolute
      // URL here would point every tenant's installed app at whichever school was hardcoded.
      expect(m.start_url.startsWith('/')).toBe(true);
      expect(m.scope === undefined || m.scope.startsWith('/')).toBe(true);
    });

    test('the start_url actually resolves', async ({ request, baseURL }) => {
      // ⚠️ **Added 2026-09-06 after staff-web shipped without a root page.** Its `/` returned 404,
      // so the bare origin — and therefore the installed app's cold start — opened on "This page
      // could not be found". A manifest can be perfectly valid and still point at nothing; the only
      // thing that proves otherwise is fetching it.
      const m = await (await request.get(`${baseURL}/manifest.webmanifest`)).json();
      const res = await request.get(`${baseURL}${m.start_url}`);
      expect(res.status(), `start_url ${m.start_url} should resolve`).toBe(200);
    });

    test('every icon the manifest names resolves at the size it claims', async ({ request, baseURL }) => {
      const m = await (await request.get(`${baseURL}/manifest.webmanifest`)).json();

      for (const icon of m.icons as { src: string; sizes: string }[]) {
        const res = await request.get(`${baseURL}${icon.src}`);
        expect(res.status(), `${icon.src} should resolve`).toBe(200);
        const body = await res.body();

        // PNG signature, then IHDR width/height at bytes 16..23, big-endian. Dependency-free, and it
        // catches the failure a 200 cannot: a file served happily at the wrong dimensions. Chrome
        // refuses to install when a manifest claims 512x512 and the bytes say otherwise.
        expect(body.subarray(0, 8).toString('hex'), `${icon.src} should be a PNG`).toBe('89504e470d0a1a0a');
        const [w, h] = icon.sizes.split('x').map(Number);
        expect(`${body.readUInt32BE(16)}x${body.readUInt32BE(20)}`, `${icon.src} pixel size`).toBe(`${w}x${h}`);
      }
    });

    test('the page head carries what Android and iOS each need', async ({ page, baseURL }) => {
      await page.goto(`${baseURL}/login`);

      await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', /manifest\.webmanifest$/);
      // Android paints the status bar from this; without it an installed window still looks like a
      // web page, which is most of what "installed" means to a teacher.
      // ⚠️ **Pinned to the literal brand on purpose — this is the assertion that caught the U0
      // retheme leaving `app/manifest.ts` behind.** The meta tag moved to the new brand and the
      // manifest did not, so an installed app painted one colour in the status bar and another on
      // the splash. A regex or a "matches the manifest" comparison would have agreed with both and
      // caught nothing. When the brand moves, three places move together: `globals.css` `--brand`,
      // `layout.tsx` `themeColor`, and `manifest.ts` `theme_color` — and this line is what says so.
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#17365c');

      // ⚠️ `viewport-fit=cover` is load-bearing, not cosmetic: `env(safe-area-inset-*)` evaluates to
      // ZERO without it, so the teacher tab bar and the register's save bar would sit under the home
      // indicator on exactly the phones this was built for. It was missing until M4.
      await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/);

      // iOS ignores the manifest for standalone display and reads these two instead, so both
      // families need their own answer.
      await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes');
      await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
    });
  });
}
