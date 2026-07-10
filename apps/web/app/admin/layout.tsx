'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api';
import { platformApi, type PlatformUser } from '@/lib/platform-api';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const isLogin = pathname === '/admin/login';
  const [me, setMe] = useState<PlatformUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // The login page renders on its own, without a session check.
    if (isLogin) { setReady(true); return; }
    platformApi.me()
      .then(setMe)
      .catch((e) => { if (e instanceof ApiError && e.status === 401) router.replace('/admin/login'); })
      .finally(() => setReady(true));
  }, [router, isLogin]);

  if (isLogin) return <>{children}</>;
  if (!ready) return <main className="container"><p className="muted">Loading…</p></main>;
  if (!me) return null;

  return (
    <div className="content" style={{ maxWidth: 1100, margin: '0 auto' }}>
      <div className="topbar">
        <strong>🛠️ Vendor Console</strong>
        <span className="inline-form" style={{ alignItems: 'center' }}>
          <span className="who">{me.email}</span>
          <button className="ghost small" onClick={async () => { await platformApi.logout().catch(() => {}); router.replace('/admin/login'); }}>
            Sign out
          </button>
        </span>
      </div>
      {children}
    </div>
  );
}
