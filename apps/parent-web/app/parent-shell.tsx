'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, ApiError, type Me } from '@sw/api-client';
import { Icon, type IconName } from '@sw/ui';
import { ParentBell } from './parent-bell';
import { ChildSwitcher } from './child-switcher';

const NAV: Array<{ href: string; label: string; icon: IconName }> = [
  { href: '/', label: 'Home', icon: 'home' },
  { href: '/attendance', label: 'Attendance', icon: 'attendance' },
  { href: '/results', label: 'Results', icon: 'exams' },
  { href: '/fees', label: 'Fees', icon: 'fees' },
];

export function ParentShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const isPublic = pathname === '/login';
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (isPublic) { setReady(true); return; }
    api.me()
      .then(setMe)
      .catch((e) => { if (e instanceof ApiError && e.status === 401) router.replace('/login'); })
      .finally(() => setReady(true));
  }, [router, isPublic]);

  const handleChildSwitch = useCallback(() => {
    setRefreshKey((k) => k + 1);
    window.dispatchEvent(new Event('child-switched'));
  }, []);

  if (isPublic) return <>{children}</>;
  if (!ready) return <main className="container"><p className="muted">Loading…</p></main>;
  if (!me) return null;

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`));

  return (
    <div className="sp" key={refreshKey}>
      <header className="sp-header">
        <div className="sp-row-top">
          <Link href="/" className="sp-brand">
            <Icon name="school" size={22} />
            <span>{me.schoolName ?? 'Parent Portal'}</span>
          </Link>
          <div className="sp-actions">
            <ParentBell />
            <button type="button" className="ghost small" onClick={async () => { await api.logout().catch(() => {}); router.replace('/login'); }}>
              Sign out
            </button>
          </div>
        </div>
        <div className="sp-row-nav">
          <ChildSwitcher onSwitch={handleChildSwitch} />
          <nav className="sp-nav" aria-label="Parent portal">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className={isActive(n.href) ? 'active' : ''} aria-current={isActive(n.href) ? 'page' : undefined}>
                <Icon name={n.icon} size={16} />
                {n.label}
              </Link>
            ))}
          </nav>
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
