import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'School Management',
  description: 'Multi-tenant school management',
  // Tells iOS to launch from the home screen without Safari's chrome. Android reads this from the
  // manifest instead; Safari still ignores the manifest for standalone display, so both are needed.
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'School' },
  /**
   * Static files rather than Next's generated `app/icon.tsx`, and the reason is recorded in
   * `scripts/generate-app-icons.mjs`: the bundled `@vercel/og` cannot load its own font on Windows
   * and 500s, so every icon would have been a broken link on a Windows machine. Regenerate with
   * `node scripts/generate-app-icons.mjs`.
   */
  icons: {
    icon: [{ url: '/favicon-32.png', sizes: '32x32', type: 'image/png' }],
    apple: [{ url: '/apple-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

/**
 * ⚠️ **`viewportFit: 'cover'` is load-bearing, not decoration.**
 *
 * The teacher tab bar and the register's save bar both pad themselves with
 * `env(safe-area-inset-bottom)` so they clear the home-indicator strip on a notched phone. Those
 * `env()` values are **zero unless the viewport is `cover`** — so without this line the insets
 * silently did nothing, and the tab labels would have sat under the indicator on exactly the
 * phones the feature was built for. Added with M4; the CSS has expected it since M0.
 *
 * `themeColor` paints the Android status bar in the brand colour, which is most of what makes an
 * installed page stop looking like a web page.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#3355cc',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
