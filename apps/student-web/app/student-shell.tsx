'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, ApiError, type Me } from '@sw/api-client';

/**
 * The student portal's client shell — auth gate + a small top nav across the five read-only pages.
 * On this dedicated origin the login page renders bare (the `isPublic` bypass); everything else needs
 * a student session (the API's STUDENT-scoped `/portal/*`), and a 401 sends them to /login.
 */
const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/attendance', label: 'Attendance' },
  { href: '/timetable', label: 'Timetable' },
  { href: '/results', label: 'Results' },
  { href: '/fees', label: 'Fees' },
];

export function StudentShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const isPublic = pathname === '/login';
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (isPublic) { setReady(true); return; }
    api.me()
      .then(setMe)
      .catch((e) => { if (e instanceof ApiError && e.status === 401) router.replace('/login'); })
      .finally(() => setReady(true));
  }, [router, isPublic]);

  if (isPublic) return <>{children}</>;
  if (!ready) return <main className="container"><p className="muted">Loading…</p></main>;
  if (!me) return null;

  return (
    <div className="content" style={{ maxWidth: 900, margin: '0 auto' }}>
      <div className="topbar">
        <strong><Link href="/" style={{ color: 'inherit', textDecoration: 'none' }}>🎒 Student Portal</Link></strong>
        <span className="inline-form" style={{ alignItems: 'center' }}>
          {NAV.map((n) => (
            <Link key={n.href} className="ghost small" href={n.href} aria-current={pathname === n.href ? 'page' : undefined}>
              {n.label}
            </Link>
          ))}
          <button className="ghost small" onClick={async () => { await api.logout().catch(() => {}); router.replace('/login'); }}>
            Sign out
          </button>
        </span>
      </div>
      {children}
    </div>
  );
}
