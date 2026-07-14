'use client';

import { useEffect, useState } from 'react';
import { api, type PortalResult } from '@/lib/api';

export default function MyResults() {
  const [rows, setRows] = useState<PortalResult[] | null>(null);
  useEffect(() => { api.portal.results().then(setRows).catch(() => setRows([])); }, []);
  if (!rows) return <p className="muted">Loading…</p>;

  return (
    <div className="stack">
      <h1>My Results</h1>
      <p className="muted">Published report cards.</p>
      <table>
        <thead><tr><th>Term</th><th>Overall</th><th>Grade</th><th>Section rank</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.term}</td>
              <td>{r.overallPercent}%</td>
              <td>{r.grade}</td>
              <td>{r.sectionRank ?? '—'}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={4} className="muted">No published results yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
