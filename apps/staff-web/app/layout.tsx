import type { Metadata, Viewport } from 'next';
import { Roboto, Bitter } from 'next/font/google';
import './globals.css';

/**
 * Root layout for the standalone Staff app (Front-End Instance Separation Plan, Phase 3b). Just the
 * document shell + fonts; the school shell (sidebar, auth gate, campus lens, MFA) is the shared
 * `(app)` layout re-exported from `@sw/school-ui`, which role-gates the nav. Staff sign in at the
 * staff door (/login); it serves ops/campus-admin/accountant/HR/admission/teacher/staff.
 */
const roboto = Roboto({ subsets: ['latin'], weight: ['400', '500', '700'], variable: '--font-roboto', display: 'swap' });
const bitter = Bitter({ subsets: ['latin'], weight: ['600', '700', '800'], variable: '--font-bitter', display: 'swap' });

export const metadata: Metadata = {
  title: 'School Staff',
  description: 'Run the school day-to-day',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Staff' },
  /**
   * Static PNGs rather than Next's generated `app/icon.tsx`: the bundled `@vercel/og` cannot load
   * its own font on Windows and 500s, which would leave every icon a broken link with nothing
   * failing. Regenerate with `node scripts/generate-app-icons.mjs`.
   */
  icons: {
    icon: [{ url: '/favicon-32.png', sizes: '32x32', type: 'image/png' }],
    apple: [{ url: '/apple-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#17365c',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${roboto.variable} ${bitter.variable}`}>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
