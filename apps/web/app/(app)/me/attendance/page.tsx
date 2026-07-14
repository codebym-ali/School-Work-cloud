'use client';

import { useEffect, useState } from 'react';
import { api, type PortalAttendance } from '@/lib/api';

const badge = (s: string) => (s === 'PRESENT' ? 'ok' : s === 'ABSENT' ? 'bad' : '');

export default function MyAttendance() {
  const [rows, setRows] = useState<PortalAttendance[] | null>(null);
  useEffect(() => { api.portal.attendance().then(setRows).catch(() => setRows([])); }, []);
  if (!rows) return <p className="muted">Loading…</p>;

  return (
    <div className="stack">
      <h1>My Attendance</h1>
      <p className="muted">Your most recent {rows.length} record(s).</p>
      <table>
        <thead><tr><th>Date</th><th>Session</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{new Date(r.date).toLocaleDateString()}</td>
              <td>{r.session}</td>
              <td><span className={`badge ${badge(r.status)}`}>{r.status}</span></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={3} className="muted">No attendance recorded yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
