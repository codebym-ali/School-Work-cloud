'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api';
import { platformApi, type PlatformUser } from '@/lib/platform-api';
import { PlatformMeContext } from './me-context';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const isLogin = pathname === '/admin/login';
  // The pre-login public pages render on their own, without a session check: the login door and the
  // operator set-password page (SA4b — an INVITED operator has no session yet).
  const isPublic = isLogin || pathname === '/admin/set-password';
  const [me, setMe] = useState<PlatformUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (isPublic) { setReady(true); return; }
    platformApi.me()
      .then(setMe)
      .catch((e) => { if (e instanceof ApiError && e.status === 401) router.replace('/admin/login'); })
      .finally(() => setReady(true));
  }, [router, isPublic]);

  if (isPublic) return <>{children}</>;
  if (!ready) return <main className="container"><p className="muted">Loading…</p></main>;
  if (!me) return null;

  const onSecurity = pathname === '/admin/security';

  return (
    <PlatformMeContext.Provider value={me}>
      <div className="content" style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div className="topbar">
          <strong><Link href="/admin" style={{ color: 'inherit', textDecoration: 'none' }}>🛠️ Vendor Console</Link></strong>
          <span className="inline-form" style={{ alignItems: 'center' }}>
            <Link className="ghost small" href="/admin">Tenants</Link>
            {(me.role === 'SUPER_ADMIN' || me.role === 'SUPPORT') && <Link className="ghost small" href="/admin/leads">Leads</Link>}
            {(me.role === 'SUPER_ADMIN' || me.role === 'BILLING') && <Link className="ghost small" href="/admin/billing">Billing</Link>}
            {me.role === 'SUPER_ADMIN' && <Link className="ghost small" href="/admin/operators">Operators</Link>}
            <span className="who">{me.email}</span>
            {!onSecurity && <Link className="ghost small" href="/admin/security">Security</Link>}
            <button className="ghost small" onClick={async () => { await platformApi.logout().catch(() => {}); router.replace('/admin/login'); }}>
              Sign out
            </button>
          </span>
        </div>
        {children}
      </div>
    </PlatformMeContext.Provider>
  );
}
