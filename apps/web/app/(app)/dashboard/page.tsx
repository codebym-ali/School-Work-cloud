'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type AdmissionsSummary, type Dashboard } from '@/lib/api';
import { useMe } from '@/lib/me-context';
import { canReach } from '@/lib/roles';

type Tile = {
  key: keyof Dashboard;
  label: string;
  href: string;
  icon: string;
  fmt?: (v: number) => string;
  alert?: (v: number) => boolean;
};

const SECTIONS: Array<{ title: string; tiles: Tile[] }> = [
  {
    title: 'Academics & Enrollment',
    tiles: [
      { key: 'enrollmentCount', label: 'Active students', href: '/students', icon: '👥' },
      { key: 'todayAttendancePercent', label: "Today's attendance", href: '/attendance', icon: '✅', fmt: (v) => `${v}%`, alert: (v) => v < 75 },
      { key: 'pendingLeaves', label: 'Pending leaves', href: '/attendance', icon: '📄', alert: (v) => v > 0 },
    ],
  },
  {
    title: 'Finance',
    tiles: [
      { key: 'monthCollections', label: 'Collections (month)', href: '/fees', icon: '💳', fmt: (v) => `Rs ${v.toLocaleString()}` },
      { key: 'defaulterCount', label: 'Defaulters', href: '/reports', icon: '📈', alert: (v) => v > 0 },
    ],
  },
  {
    title: 'Communication',
    tiles: [
      { key: 'failedSmsCount', label: 'Failed SMS', href: '/reports', icon: '📨', alert: (v) => v > 0 },
    ],
  },
];

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

export default function DashboardPage() {
  const me = useMe();
  const [data, setData] = useState<Dashboard | null>(null);
  const [adm, setAdm] = useState<AdmissionsSummary | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    api.dashboard().then(setData).catch(() => setErr(true));
    // Every figure in this summary counts Inquiry rows, so in a DIRECT school (no enquiry
    // pipeline) the card would advertise "0 open inquiries · 0% conversion" for ever — a
    // metric that can never move is worse than no metric. Skip the fetch entirely.
    if (me?.admissionsMode === 'PIPELINE') api.admissions.summary().then(setAdm).catch(() => {});
  }, [me?.admissionsMode]);

  if (err) return <p className="error">Couldn&apos;t load the dashboard.</p>;
  if (!data) return <p className="muted">Loading…</p>;

  // Show a tile only when the metric is role-visible AND the role can open its destination —
  // otherwise it dead-ends on the "Not authorized" screen (e.g. Collections → /fees for a
  // campus admin, who sees the financial metric but has no Fees access).
  const visible = (t: Tile) => data.visible.includes(t.key) && canReach(me?.roles, t.href, me?.admissionsMode);
  const val = (t: Tile) => data[t.key] as number | null;
  const display = (t: Tile) => {
    const v = val(t);
    return v == null ? '—' : t.fmt ? t.fmt(v) : String(v);
  };
  const isAlert = (t: Tile) => {
    const v = val(t);
    return v != null && !!t.alert?.(v);
  };

  const attention: Array<{ text: string; href: string }> = [];
  if ((data.defaulterCount ?? 0) > 0 && data.visible.includes('defaulterCount')) attention.push({ text: `${data.defaulterCount} fee defaulter${data.defaulterCount === 1 ? '' : 's'}`, href: '/reports' });
  if ((data.pendingLeaves ?? 0) > 0 && data.visible.includes('pendingLeaves')) attention.push({ text: `${data.pendingLeaves} leave request${data.pendingLeaves === 1 ? '' : 's'} pending`, href: '/attendance' });
  if ((data.failedSmsCount ?? 0) > 0 && data.visible.includes('failedSmsCount')) attention.push({ text: `${data.failedSmsCount} failed SMS`, href: '/reports' });
  if (adm && adm.totals.readyToAdmit > 0) attention.push({ text: `${adm.totals.readyToAdmit} student${adm.totals.readyToAdmit === 1 ? '' : 's'} ready to admit`, href: '/admissions' });
  if (adm && adm.testsToday > 0) attention.push({ text: `${adm.testsToday} entry test${adm.testsToday === 1 ? '' : 's'} today`, href: '/admissions' });

  const reachableAttention = attention.filter((a) => canReach(me?.roles, a.href, me?.admissionsMode));

  const empty = (data.enrollmentCount ?? 0) === 0;

  return (
    <div className="stack">
      <div>
        <h1 style={{ marginBottom: 2 }}>{greeting()}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · {me?.email}
        </p>
      </div>

      <div className="card stack" style={{ borderLeft: reachableAttention.length ? '4px solid #d97706' : '4px solid #16a34a' }}>
        <div className="row">
          <strong style={{ fontSize: 15 }}>{reachableAttention.length ? '⚠ Needs attention' : '✓ All clear'}</strong>
          {reachableAttention.length > 0 && <span className="badge warn">{reachableAttention.length}</span>}
        </div>
        {reachableAttention.length === 0 ? (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>Nothing is waiting on you right now.</p>
        ) : (
          <div className="row" style={{ justifyContent: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
            {reachableAttention.map((a, i) => (
              <Link key={i} className="chip" href={a.href}>{a.text} →</Link>
            ))}
          </div>
        )}
      </div>

      {SECTIONS.map((s) => {
        const tiles = s.tiles.filter(visible);
        if (!tiles.length) return null;
        return (
          <div key={s.title}>
            <div className="section-title">{s.title}</div>
            <div className="grid">
              {tiles.map((t) => (
                <Link key={t.key} href={t.href} className={`metric metric-link ${isAlert(t) ? 'metric-alert' : ''}`}>
                  <div className="row" style={{ alignItems: 'flex-start' }}>
                    <div className="value">{display(t)}</div>
                    <span style={{ fontSize: 18 }} aria-hidden="true">{t.icon}</span>
                  </div>
                  <div className="label">{t.label}</div>
                  <div className="metric-go">View →</div>
                </Link>
              ))}
            </div>
          </div>
        );
      })}

      {adm && (
        <div>
          <div className="section-title">Pipelines</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px,1fr))', gap: 14 }}>
            {adm && (
              <Link href="/admissions" className="card metric-link pipeline-card">
                <div className="row">
                  <strong style={{ fontSize: 14 }}>📝 Admissions</strong>
                  <span className="metric-go">View pipeline →</span>
                </div>
                <div className="value" style={{ marginTop: 6 }}>{adm.totals.open}</div>
                <div className="label">open inquiries</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  {adm.conversionRate}% conversion · {adm.admittedThisMonth} admitted this month
                </div>
              </Link>
            )}
          </div>
        </div>
      )}

      {empty && (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            New here? Go to <b>Setup</b> to create an academic year, campus, class and section,
            then add students under <b>Students</b> — the metrics above will start filling in.
          </p>
        </div>
      )}
    </div>
  );
}
