'use client';

import { useEffect, useState } from 'react';
import { api, type Dashboard } from '@/lib/api';

const METRICS: Array<{ key: keyof Dashboard; label: string; fmt?: (v: number) => string }> = [
  { key: 'enrollmentCount', label: 'Active students' },
  { key: 'todayAttendancePercent', label: "Today's attendance", fmt: (v) => `${v}%` },
  { key: 'monthCollections', label: 'Collections (month)', fmt: (v) => `Rs ${v.toLocaleString()}` },
  { key: 'defaulterCount', label: 'Defaulters' },
  { key: 'pendingLeaves', label: 'Pending leaves' },
  { key: 'failedSmsCount', label: 'Failed SMS' },
];

export default function DashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);

  useEffect(() => { api.dashboard().then(setData).catch(() => {}); }, []);

  return (
    <div className="stack">
      <h1>Dashboard</h1>
      {!data ? <p className="muted">Loading…</p> : (
        <div className="grid">
          {METRICS.filter((m) => data.visible.includes(m.key)).map((m) => {
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
      )}
      <div className="card">
        <p className="muted" style={{ margin: 0 }}>
          New here? Go to <b>Setup</b> to create an academic year, campus, class and section,
          then add students under <b>Students</b> — the metrics above will start filling in.
        </p>
      </div>
    </div>
  );
}
