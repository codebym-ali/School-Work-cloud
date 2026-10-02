'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, ApiError, type Me } from '@sw/api-client';
import { Icon, type IconName } from '@sw/ui';
import { ParentBell } from './parent-bell';

/**
 * The parent portal's client shell — auth gate + navigation across the five read-only pages.
 * On this dedicated origin the login page renders bare (the `isPublic` bypass); everything else needs
 * a student session (the API's STUDENT-scoped `/portal/*`), and a 401 sends them to /login.
 */
const NAV: Array<{ href: string; label: string; icon: IconName }> = [
  { href: '/', label: 'Home', icon: 'home' },
  { href: '/attendance', label: 'Attendance', icon: 'attendance' },
  { href: '/timetable', label: 'Timetable', icon: 'timetable' },
  { href: '/results', label: 'Results', icon: 'exams' },
  { href: '/fees', label: 'Fees', icon: 'fees' },
];

export function ParentShell({ children }: { children: React.ReactNode }) {
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

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`));

  return (
    <div className="sp">
      <header className="sp-top">
        <Link href="/" className="sp-brand">
          <Icon name="school" size={22} />
          <span>{me.schoolName ?? 'Parent Portal'}{me.campusName ? ` · ${me.campusName}` : ''}</span>
        </Link>
        <nav className="sp-nav" aria-label="Parent portal">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={isActive(n.href) ? 'page' : undefined}>{n.label}</Link>
          ))}
        </nav>
        <div className="sp-actions">
          <ParentBell />
          <button type="button" className="ghost small" onClick={async () => { await api.logout().catch(() => {}); router.replace('/login'); }}>
            Sign out
          </button>
        </div>
      </header>

      <main>{children}</main>

      <nav className="tabbar" aria-label="Parent portal">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={`tab${isActive(n.href) ? ' active' : ''}`} aria-current={isActive(n.href) ? 'page' : undefined}>
            <span className="tab-icon"><Icon name={n.icon} size={22} /></span>
            {n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
