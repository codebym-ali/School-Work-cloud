import type { Metadata, Viewport } from 'next';
import { Roboto, Bitter } from 'next/font/google';
import './globals.css';

/**
 * Root layout for the standalone Owner app (Front-End Instance Separation Plan, Phase 3b). Just the
 * document shell + fonts; the school shell (sidebar, auth gate, campus lens, MFA) is the shared
 * `(app)` layout re-exported from `@sw/school-ui`. The owner signs in at the owner door (/login).
 */
const roboto = Roboto({ subsets: ['latin'], weight: ['400', '500', '700'], variable: '--font-roboto', display: 'swap' });
const bitter = Bitter({ subsets: ['latin'], weight: ['600', '700', '800'], variable: '--font-bitter', display: 'swap' });

export const metadata: Metadata = {
  title: 'School Owner',
  description: 'Manage your school',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Owner' },
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
