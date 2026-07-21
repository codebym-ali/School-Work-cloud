'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, ApiError, type Me } from '@/lib/api';
import { MeContext } from '@/lib/me-context';
import { groupedNav, hasAnyRole, navItemFor, panelLabel } from '@/lib/roles';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api.me()
      .then(setMe)
      .catch((e) => { if (e instanceof ApiError && e.status === 401) router.replace('/login'); })
      .finally(() => setReady(true));
  }, [router]);

  if (!ready) return <main className="container"><p className="muted">Loading…</p></main>;
  if (!me) return null;

  // Show only the screens this role can use, grouped into sidebar categories;
  // gate the routed page centrally.
  const nav = groupedNav(me.roles);
  const current = navItemFor(pathname);
  const authorized = !current || hasAnyRole(me.roles, current.roles);

  return (
    <MeContext.Provider value={me}>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">🏫 {panelLabel(me.roles)}</div>
          {nav.map(({ group, items }) => (
            <div key={group} className="nav-group">
              <div className="group-label">{group}</div>
              {items.map((n) => (
                <Link key={n.href} href={n.href} className={pathname.startsWith(n.href) ? 'active' : ''}>
                  <span className="nav-icon" aria-hidden="true">{n.icon}</span>
                  {n.label}
                </Link>
              ))}
            </div>
          ))}
        </aside>
        <div className="content">
          <div className="topbar">
            <div className="who">{me.email} · {me.roles.join(', ')}</div>
            <button className="ghost small" onClick={async () => { await api.logout().catch(() => {}); router.replace('/login'); }}>
              Sign out
            </button>
          </div>
          {authorized ? children : (
            <div className="card stack">
              <h1>Not authorized</h1>
              <p className="muted">Your role ({me.roles.join(', ')}) doesn’t have access to this screen.</p>
            </div>
          )}
        </div>
      </div>
    </MeContext.Provider>
  );
}
