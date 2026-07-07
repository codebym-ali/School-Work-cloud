'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, ApiError, type Me } from '@/lib/api';

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/setup', label: 'Setup' },
  { href: '/students', label: 'Students' },
  { href: '/attendance', label: 'Attendance' },
  { href: '/fees', label: 'Fees' },
  { href: '/reports', label: 'Reports' },
];

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

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">🏫 School Admin</div>
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={pathname.startsWith(n.href) ? 'active' : ''}>
            {n.label}
          </Link>
        ))}
      </aside>
      <div className="content">
        <div className="topbar">
          <div className="who">{me.email} · {me.roles.join(', ')}</div>
          <button className="ghost small" onClick={async () => { await api.logout().catch(() => {}); router.replace('/login'); }}>
            Sign out
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
