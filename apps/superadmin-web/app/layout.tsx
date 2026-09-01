import type { Metadata, Viewport } from 'next';
import { Roboto, Bitter } from 'next/font/google';
import './globals.css';
import { ConsoleShell } from './console-shell';

/**
 * Root layout for the standalone SuperAdmin console. Mirrors apps/web's font + shell pattern (Roboto
 * body / Bitter headings, self-hosted by next/font so the CSP-blocked font CDN is never hit), but this
 * is a SEPARATE app on its own origin — it shares only the design system (globals.css) and the
 * react-free `@sw/*` packages, never tenant code.
 */
const roboto = Roboto({ subsets: ['latin'], weight: ['400', '500', '700'], variable: '--font-roboto', display: 'swap' });
const bitter = Bitter({ subsets: ['latin'], weight: ['600', '700', '800'], variable: '--font-bitter', display: 'swap' });

export const metadata: Metadata = {
  title: 'Vendor Console',
  description: 'School-works platform administration',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#17365c',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${roboto.variable} ${bitter.variable}`}>
      <body>
        <ConsoleShell>{children}</ConsoleShell>
      </body>
    </html>
  );
}
