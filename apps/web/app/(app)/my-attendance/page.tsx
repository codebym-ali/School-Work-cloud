'use client';

import { useEffect, useState } from 'react';
import { api, type StaffAttendanceRow } from '@/lib/api';
import { attendanceBadge, humanizeStatus } from '@/lib/format';

const time = (t: string | null) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');

export default function MyAttendance() {
  const [rows, setRows] = useState<StaffAttendanceRow[] | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => { api.staff.myAttendance().then(setRows).catch(() => setErr(true)); }, []);

  if (err) return <p className="error">Couldn&apos;t load your attendance.</p>;
  if (!rows) return <p className="muted">Loading…</p>;

  // Attendance ratio: PRESENT/LATE = full day, HALF_DAY = half; leave days aren't counted
  // against you, so they're excluded from the denominator entirely.
  const countable = rows.filter((r) => r.status !== 'ON_LEAVE');
  const credit = countable.reduce((s, r) => s + (r.status === 'PRESENT' || r.status === 'LATE' ? 1 : r.status === 'HALF_DAY' ? 0.5 : 0), 0);
  const pct = countable.length ? Math.round((credit / countable.length) * 100) : null;

  return (
    <div className="stack">
      <h1>My Attendance</h1>
      <div className="grid">
        <div className="metric"><div className="value">{pct == null ? '—' : `${pct}%`}</div><div className="label">Attendance (recent)</div></div>
        <div className="metric"><div className="value">{rows.length}</div><div className="label">Records</div></div>
      </div>
      <div className="card stack">
        <h2 style={{ margin: 0, fontSize: 17 }}>Recent records</h2>
        <table>
          <thead><tr><th>Date</th><th>Session</th><th>Status</th><th>Check-in</th><th>Check-out</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{new Date(r.date).toLocaleDateString()}</td>
                <td>{r.session}</td>
                <td><span className={`badge ${attendanceBadge(r.status)}`}>{humanizeStatus(r.status)}</span></td>
                <td>{time(r.checkIn)}</td>
                <td>{time(r.checkOut)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="muted">No attendance records yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
