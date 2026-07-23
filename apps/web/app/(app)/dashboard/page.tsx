'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type AdmissionsSummary, type Dashboard, type RecruitmentSummary } from '@/lib/api';
import { useMe } from '@/lib/me-context';

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
  const [rec, setRec] = useState<RecruitmentSummary | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    api.dashboard().then(setData).catch(() => setErr(true));
    api.admissions.summary().then(setAdm).catch(() => {});
    api.vacancies.summary().then(setRec).catch(() => {});
  }, []);

  if (err) return <p className="error">Couldn&apos;t load the dashboard.</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const visible = (t: Tile) => data.visible.includes(t.key);
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
  if (rec && (rec.applicationsByStatus.SUBMITTED ?? 0) > 0) attention.push({ text: `${rec.applicationsByStatus.SUBMITTED} new teacher application${rec.applicationsByStatus.SUBMITTED === 1 ? '' : 's'}`, href: '/recruitment' });

  const empty = (data.enrollmentCount ?? 0) === 0;

  return (
    <div className="stack">
      <div>
        <h1 style={{ marginBottom: 2 }}>{greeting()}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · {me?.email}
        </p>
      </div>

      <div className="card stack" style={{ borderLeft: attention.length ? '4px solid #d97706' : '4px solid #16a34a' }}>
        <div className="row">
          <strong style={{ fontSize: 15 }}>{attention.length ? '⚠ Needs attention' : '✓ All clear'}</strong>
          {attention.length > 0 && <span className="badge warn">{attention.length}</span>}
        </div>
        {attention.length === 0 ? (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>Nothing is waiting on you right now.</p>
        ) : (
          <div className="row" style={{ justifyContent: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
            {attention.map((a, i) => (
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
          <div className="section-title">Admissions pipeline</div>
          <div className="grid">
            <Link href="/admissions" className="metric metric-link">
              <div className="value">{adm.totals.open}</div><div className="label">Open inquiries</div><div className="metric-go">View →</div>
            </Link>
            <Link href="/admissions" className={`metric metric-link ${adm.testsToday > 0 ? 'metric-alert' : ''}`}>
              <div className="value">{adm.testsToday}</div><div className="label">Tests today</div><div className="metric-go">View →</div>
            </Link>
            <Link href="/admissions" className={`metric metric-link ${adm.totals.readyToAdmit > 0 ? 'metric-alert' : ''}`}>
              <div className="value">{adm.totals.readyToAdmit}</div><div className="label">Ready to admit</div><div className="metric-go">View →</div>
            </Link>
            <Link href="/admissions" className="metric metric-link">
              <div className="value">{adm.admittedThisMonth}</div><div className="label">Admitted this month</div><div className="metric-go">View →</div>
            </Link>
            <Link href="/admissions" className="metric metric-link">
              <div className="value">{adm.conversionRate}%</div><div className="label">Conversion rate</div><div className="metric-go">View →</div>
            </Link>
          </div>
        </div>
      )}

      {rec && (
        <div>
          <div className="section-title">People & Recruitment</div>
          <div className="grid">
            <Link href="/recruitment" className="metric metric-link">
              <div className="value">{rec.openVacancies}</div><div className="label">Open vacancies</div><div className="metric-go">View →</div>
            </Link>
            <Link href="/recruitment" className={`metric metric-link ${(rec.applicationsByStatus.SUBMITTED ?? 0) > 0 ? 'metric-alert' : ''}`}>
              <div className="value">{rec.applicationsByStatus.SUBMITTED ?? 0}</div><div className="label">New applications</div><div className="metric-go">View →</div>
            </Link>
            <Link href="/recruitment" className="metric metric-link">
              <div className="value">{rec.applicationsByStatus.SHORTLISTED ?? 0}</div><div className="label">Shortlisted</div><div className="metric-go">View →</div>
            </Link>
            <Link href="/recruitment" className="metric metric-link">
              <div className="value">{rec.hiredThisMonth}</div><div className="label">Hired this month</div><div className="metric-go">View →</div>
            </Link>
            <Link href="/staff" className="metric metric-link">
              <div className="value">{rec.openPositions}</div><div className="label">Open positions</div><div className="metric-go">View →</div>
            </Link>
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
