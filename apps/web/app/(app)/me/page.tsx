'use client';

import { type ReactNode, useEffect, useState } from 'react';
import { api, type PortalOverview } from '@/lib/api';

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

      <div className="grid">
        <div className="metric"><div className="value">{data.attendancePercent == null ? '—' : `${data.attendancePercent}%`}</div><div className="label">Attendance</div></div>
        <div className="metric"><div className="value">Rs {data.outstandingFees.toLocaleString()}</div><div className="label">Outstanding fees</div></div>
        <div className="metric"><div className="value">{data.reportCards}</div><div className="label">Report cards</div></div>
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
        <table>
          <thead><tr><th>Name</th><th>Relation</th><th>Phone</th></tr></thead>
          <tbody>
            {data.guardians.map((g, i) => (
              <tr key={i}>
                <td>{g.name}{g.isPrimary && <span className="badge ok" style={{ marginLeft: 6 }}>primary</span>}</td>
                <td>{g.relation}</td>
                <td>{g.phone}</td>
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
