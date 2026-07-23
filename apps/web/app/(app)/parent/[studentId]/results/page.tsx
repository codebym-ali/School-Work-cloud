'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, type PortalResult } from '@/lib/api';
import { ChildNav } from '../child-nav';

export default function ChildResults() {
  const { studentId } = useParams<{ studentId: string }>();
  const [rows, setRows] = useState<PortalResult[] | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => { api.parent.results(studentId).then(setRows).catch(() => setErr(true)); }, [studentId]);

  return (
    <div className="stack">
      <ChildNav studentId={studentId} />
      {err ? (
        <p className="error">Couldn&apos;t load results.</p>
      ) : !rows ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="card stack">
          <h2 style={{ margin: 0, fontSize: 17 }}>Report cards</h2>
          <table>
            <thead><tr><th>Term</th><th>Overall</th><th>Grade</th><th>Rank</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.term}</td>
                  <td>{r.overallPercent}%</td>
                  <td><span className="badge ok">{r.grade}</span></td>
                  <td>{r.sectionRank ?? '—'}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={4} className="muted">No report cards published yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
