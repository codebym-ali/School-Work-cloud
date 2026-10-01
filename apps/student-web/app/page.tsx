'use client';

import { type ReactNode, useEffect, useState } from 'react';
import { api, type PortalOverview } from '@sw/api-client';
import { MetricLink } from '@/components/metric';
import { STUDENT_STATUS, statusStyle } from '@sw/ui';

export default function MyDashboard() {
  const [data, setData] = useState<PortalOverview | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => { api.portal.overview().then(setData).catch(() => setErr(true)); }, []);

  if (err) return <p className="error">Couldn&apos;t load your dashboard.</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const s = data.student;

  return (
    <div className="stack">
      <h1>Welcome, {s.fullName}</h1>

      {/* A suspended student keeps portal access precisely so they can read this. */}
      {s.status !== 'ACTIVE' && (
        <div className="card stack" style={{ ...statusStyle(s.status), gap: 6 }}>
          <strong>Status: {STUDENT_STATUS[s.status].label}</strong>
          {s.status === 'SUSPENDED' && (
            <span>
              You are suspended{s.statusEndsOn ? ` until ${new Date(s.statusEndsOn).toLocaleDateString()}` : ''}.
              Please contact the school office.
            </span>
          )}
          {s.statusReason && <span style={{ fontSize: 13 }}>Reason: {s.statusReason}</span>}
        </div>
      )}

      <div className="grid">
        {/* The clearest case in the product for Law 1: every one of these already HAS a screen
            behind it, and a student reading "Rs 4,500 outstanding" wants the invoice, not the
            number. Each tile is the front door of the page it summarises. */}
        <MetricLink label="Attendance" href="/attendance"
          value={data.attendancePercent == null ? '—' : `${data.attendancePercent}%`} />
        <MetricLink label="Outstanding fees" href="/fees" alert={data.outstandingFees > 0}
          value={`Rs ${data.outstandingFees.toLocaleString()}`} />
        <MetricLink label="Report cards" href="/results" value={data.reportCards} />
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0, fontSize: 17 }}>My details</h2>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px,1fr))' }}>
          <Field label="GR number" value={s.grNumber} />
          <Field label="Class" value={data.enrollment ? `${data.enrollment.className} — ${data.enrollment.sectionName}` : '—'} />
          <Field label="Roll number" value={data.enrollment?.rollNumber ?? '—'} />
          <Field label="Academic year" value={data.enrollment?.year ?? '—'} />
          <Field label="Gender" value={s.gender} />
          <Field label="Date of birth" value={new Date(s.dateOfBirth).toLocaleDateString()} />
        </div>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0, fontSize: 17 }}>Guardians</h2>
        <table className="stacked">
          <thead><tr><th>Name</th><th>Relation</th><th>Phone</th></tr></thead>
          <tbody>
            {data.guardians.map((g, i) => (
              <tr key={i}>
                <td data-label="Name">{g.name}{g.isPrimary && <span className="badge ok" style={{ marginLeft: 6 }}>primary</span>}</td>
                <td data-label="Relation">{g.relation}</td>
                <td data-label="Phone">{g.phone}</td>
              </tr>
            ))}
            {data.guardians.length === 0 && <tr><td colSpan={3} className="muted">No guardians on file.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return <div><div className="muted" style={{ fontSize: 12 }}>{label}</div><div>{value}</div></div>;
}
