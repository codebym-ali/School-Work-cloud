import type { Metadata, Viewport } from 'next';
import { Roboto, Bitter } from 'next/font/google';
import './globals.css';
import { StudentShell } from './student-shell';

/**
 * Root layout for the standalone Student portal (Front-End Instance Separation Plan, Phase 2).
 * A separate app on its own origin — it shares only the design system (globals.css) and the react-free
 * `@sw/*` packages, never staff/owner code. Read-only, so it stays deliberately small.
 */
const roboto = Roboto({ subsets: ['latin'], weight: ['400', '500', '700'], variable: '--font-roboto', display: 'swap' });
const bitter = Bitter({ subsets: ['latin'], weight: ['600', '700', '800'], variable: '--font-bitter', display: 'swap' });

export const metadata: Metadata = {
  title: 'Student Portal',
  description: 'Your attendance, timetable, results and fees',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Student' },
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
      <body>
        <StudentShell>{children}</StudentShell>
      </body>
    </html>
  );
}
