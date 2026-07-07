'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, type Dashboard, type Me } from '@/lib/api';

const METRICS: Array<{ key: keyof Dashboard; label: string; fmt?: (v: number) => string }> = [
  { key: 'enrollmentCount', label: 'Active students' },
  { key: 'todayAttendancePercent', label: "Today's attendance", fmt: (v) => `${v}%` },
  { key: 'monthCollections', label: 'Collections (month)', fmt: (v) => `Rs ${v.toLocaleString()}` },
  { key: 'defaulterCount', label: 'Defaulters' },
  { key: 'pendingLeaves', label: 'Pending leaves' },
  { key: 'failedSmsCount', label: 'Failed SMS' },
];

export default function DashboardPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [meRes, dash] = await Promise.all([api.me(), api.dashboard()]);
        setMe(meRes);
        setData(dash);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) router.replace('/login');
        else setError(err instanceof ApiError ? err.message : 'Failed to load');
      }
    })();
  }, [router]);

  async function onLogout() {
    await api.logout().catch(() => undefined);
    router.replace('/login');
  }

  if (error) return <main className="container"><p className="error">{error}</p></main>;
  if (!data || !me) return <main className="container"><p className="sub">Loading…</p></main>;

  return (
    <main className="container stack">
      <div className="row">
        <div>
          <h1>Dashboard</h1>
          <p className="sub">{me.email} · {me.roles.join(', ')}</p>
        </div>
        <button className="ghost" onClick={onLogout}>Sign out</button>
      </div>

      <div className="grid">
        {METRICS.map((m) => {
          const v = data[m.key];
          const display = v == null ? '—' : m.fmt ? m.fmt(v as number) : String(v);
          return (
            <div className="metric" key={m.key}>
              <div className="value">{display}</div>
              <div className="label">{m.label}</div>
            </div>
          );
        })}
      </div>

      <div className="card">
        <p className="sub" style={{ margin: 0 }}>
          This is the M-hardening frontend scaffold — auth + dashboard wired to the API.
          Full role-based screens (admissions, fees, attendance, exams, reports) come next.
        </p>
      </div>
    </main>
  );
}
