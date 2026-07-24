'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, type PortalAttendance } from '@/lib/api';
import { attendanceBadge, humanizeStatus } from '@/lib/format';
import { ChildNav } from '../child-nav';

export default function ChildAttendance() {
  const { studentId } = useParams<{ studentId: string }>();
  const [rows, setRows] = useState<PortalAttendance[] | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => { api.parent.attendance(studentId).then(setRows).catch(() => setErr(true)); }, [studentId]);

  return (
    <div className="stack">
      <ChildNav studentId={studentId} />
      {err ? (
        <p className="error">Couldn&apos;t load attendance.</p>
      ) : !rows ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="card stack">
          <h2 style={{ margin: 0, fontSize: 17 }}>Recent attendance</h2>
          <table>
            <thead><tr><th>Date</th><th>Session</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{new Date(r.date).toLocaleDateString()}</td>
                  <td>{r.session}</td>
                  <td><span className={`badge ${attendanceBadge(r.status)}`}>{humanizeStatus(r.status)}</span></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={3} className="muted">No attendance records yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
