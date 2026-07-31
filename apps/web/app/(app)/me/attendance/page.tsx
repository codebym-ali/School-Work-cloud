'use client';

import { useEffect, useState } from 'react';
import { api, type PortalAttendanceSummary } from '@/lib/api';
import { attendanceBadge, humanizeStatus } from '@/lib/format';

/**
 * My Attendance — the counts first, the day list second.
 *
 * "How many days was I absent?" is the actual question, and it was previously answerable only by
 * counting 60 rows by hand. The percentage uses the same shared helper as the teacher, staff and
 * SMS paths, so one student never has two different figures depending on the screen.
 */
export default function MyAttendance() {
  const [data, setData] = useState<PortalAttendanceSummary | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => { api.portal.attendanceSummary().then(setData).catch(() => setErr(true)); }, []);

  if (err) return <p className="error">Couldn&apos;t load your attendance.</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const c = data.counts;
  const cards: Array<{ label: string; value: number; tone?: string }> = [
    { label: 'Present', value: c.PRESENT ?? 0 },
    { label: 'Absent', value: c.ABSENT ?? 0, tone: (c.ABSENT ?? 0) > 0 ? 'metric-alert' : undefined },
    { label: 'Late', value: c.LATE ?? 0 },
    { label: 'Half day', value: c.HALF_DAY ?? 0 },
    { label: 'On leave', value: c.ON_LEAVE ?? 0 },
  ];

  return (
    <div className="stack">
      <h1>My Attendance</h1>

      <div className="grid">
        <div className="metric">
          <div className="value">{data.percent == null ? '—' : `${data.percent}%`}</div>
          <div className="label">Attendance (last {data.days} days)</div>
        </div>
        {cards.map((k) => (
          <div key={k.label} className={`metric ${k.tone ?? ''}`}>
            <div className="value">{k.value}</div>
            <div className="label">{k.label}</div>
          </div>
        ))}
      </div>

      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Present and late count as a full day, half day as half. Approved leave isn&apos;t counted against you.
      </p>

      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Date</th><th>Session</th><th>Status</th></tr></thead>
          <tbody>
            {data.records.map((r, i) => (
              <tr key={i}>
                <td>{new Date(r.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</td>
                <td>{r.session}</td>
                <td><span className={`badge ${attendanceBadge(r.status)}`}>{humanizeStatus(r.status)}</span></td>
              </tr>
            ))}
            {data.records.length === 0 && <tr><td colSpan={3} className="muted">No attendance recorded in this period.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
