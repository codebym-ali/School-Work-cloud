'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, type PortalFee } from '@/lib/api';
import { feeBadge, monthYear } from '@/lib/format';
import { ChildNav } from '../child-nav';

export default function ChildFees() {
  const { studentId } = useParams<{ studentId: string }>();
  const [rows, setRows] = useState<PortalFee[] | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => { api.parent.fees(studentId).then(setRows).catch(() => setErr(true)); }, [studentId]);

  const outstanding = rows ? rows.reduce((s, r) => s + r.remaining, 0) : 0;

  return (
    <div className="stack">
      <ChildNav studentId={studentId} />
      {err ? (
        <p className="error">Couldn&apos;t load fees.</p>
      ) : !rows ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="card stack">
          <div className="row">
            <h2 style={{ margin: 0, fontSize: 17 }}>Fee invoices</h2>
            <span className="badge bad">Outstanding: Rs {outstanding.toLocaleString()}</span>
          </div>
          <table>
            <thead><tr><th>Period</th><th>Total</th><th>Paid</th><th>Remaining</th><th>Status</th><th>Due</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{monthYear(r.month, r.year)}</td>
                  <td>Rs {r.total.toLocaleString()}</td>
                  <td>Rs {r.paid.toLocaleString()}</td>
                  <td>Rs {r.remaining.toLocaleString()}</td>
                  <td><span className={`badge ${feeBadge(r.status)}`}>{r.status}</span></td>
                  <td className="muted">{r.dueDate ? new Date(r.dueDate).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6} className="muted">No invoices yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
