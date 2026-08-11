import { test, expect } from '@playwright/test';

/**
 * The app is installable to a phone home screen (Teacher Mobile Home Plan, M4c).
 *
 * **Why this is a test and not a note in a doc.** Every part of installability is a *link that
 * resolves* — a manifest, three icons, an apple-touch-icon — and links rot silently. The icons
 * exist as static PNGs precisely because the generated `app/icon.tsx` route **500s on Windows**
 * (`@vercel/og` cannot load its own font), which would have left every icon a broken link with
 * nothing failing. That is the exact shape of bug this guards.
 *
 * ⚠️ **What is deliberately NOT asserted: an install prompt.** Chrome dropped the service-worker
 * requirement for installing **from the browser menu** (m108 mobile, m112 desktop), which is what
 * makes this app installable with no service worker at all. But the *automatic* banner —
 * `beforeinstallprompt` — still requires a `fetch()` handler, so Chrome will never volunteer the
 * install. That is a consequence of the no-service-worker decision (M4b), not a defect, and the
 * teacher has to be told to use "Add to Home Screen". Asserting a prompt here would fail forever.
 * iOS Safari has never had a prompt — Add to Home Screen is always manual — so nothing changes there.
 */
test.describe('installable', () => {
  // No session needed: the manifest and icons are public, and requiring a login here would make a
  // static-asset check depend on auth.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('serves a manifest that meets every documented install criterion', async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}/manifest.webmanifest`);
    expect(res.status()).toBe(200);
    const m = await res.json();

    // Chrome's documented criteria, each one a thing that silently disables installation.
    expect(m.name).toBeTruthy();
    expect(m.short_name).toBeTruthy();
    expect(m.start_url).toBeTruthy();
    expect(['standalone', 'fullscreen', 'minimal-ui']).toContain(m.display);
    // ≥192 and ≥512 are both required, and a maskable one is what stops Android's launcher
    // cropping the edges off a square icon.
    const sizes = (m.icons as { sizes: string; purpose?: string }[]).map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(m.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);

    // `start_url` and `scope` must stay RELATIVE. Each school is its own subdomain, so an absolute
    // URL here would point every tenant's installed app at whichever school was hardcoded.
    expect(m.start_url.startsWith('/')).toBe(true);
    expect(m.scope === undefined || m.scope.startsWith('/')).toBe(true);
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
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#3355cc');

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
