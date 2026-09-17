'use client';

import { useEffect, useState } from 'react';
import { api, type CampusSummary } from '@sw/api-client';

const rs = (n: number) => `Rs ${Math.round(n).toLocaleString()}`;

/**
 * Campuses side by side (GAP-11): which campus is behind, answered on the screen that lists them.
 *
 * ⚠️ **Hidden for a single-campus school** — a one-row comparison compares nothing and pushes the page down.
 *
 * ⚠️ **Attendance shows how much of the register is marked beside the percentage.** "96%" over two marked
 * sections of twenty is not a fact about the campus; the dashboard learned that the hard way.
 *
 * The worst figure in each money column is marked, so the eye lands on the campus that needs attention
 * rather than having to read every number.
 */
export function CampusComparison() {
  const [rows, setRows] = useState<CampusSummary[] | null>(null);

  useEffect(() => { api.campusSummary().then(setRows).catch(() => setRows([])); }, []);

  if (!rows || rows.length < 2) return null;

  const maxOverdue = Math.max(...rows.map((r) => r.overdue));
  const minCollected = Math.min(...rows.map((r) => r.collectedThisMonth));

  return (
    <div className="card stack" style={{ gap: 8 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 17 }}>How the campuses compare</h2>
        <p className="muted" style={{ margin: '2px 0 0', fontSize: 13 }}>Today&apos;s register, this month&apos;s collections, and fees past due.</p>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Campus</th>
              <th style={{ textAlign: 'right' }}>Students</th>
              <th>Attendance today</th>
              <th style={{ textAlign: 'right' }}>Collected this month</th>
              <th style={{ textAlign: 'right' }}>Overdue</th>
              <th style={{ textAlign: 'right' }}>Defaulters</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const a = r.attendanceToday;
              const partial = a.expected > 0 && a.marked < a.expected;
              return (
                <tr key={r.campusId}>
                  <td><strong>{r.name}</strong></td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.activeStudents}</td>
                  <td>
                    {a.percent === null ? <span className="muted">Not marked yet</span> : <strong>{a.percent}%</strong>}
                    {a.expected > 0 && (
                      <div className={partial ? '' : 'muted'} style={{ fontSize: 12, color: partial ? '#b45309' : undefined }}>
                        {a.marked} of {a.expected} marked
                      </div>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    <span className={r.collectedThisMonth === minCollected && rows.length > 1 ? 'badge warn' : undefined}>{rs(r.collectedThisMonth)}</span>
                  </td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    <span className={r.overdue > 0 && r.overdue === maxOverdue ? 'badge bad' : undefined}>{rs(r.overdue)}</span>
                  </td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.defaulters}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
