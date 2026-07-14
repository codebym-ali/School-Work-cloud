'use client';

import { useEffect, useState } from 'react';
import { api, type PortalFee } from '@/lib/api';

const badge = (s: string) => (s === 'PAID' ? 'ok' : s === 'OVERDUE' ? 'bad' : '');

export default function MyFees() {
  const [rows, setRows] = useState<PortalFee[] | null>(null);
  useEffect(() => { api.portal.fees().then(setRows).catch(() => setRows([])); }, []);
  if (!rows) return <p className="muted">Loading…</p>;
  const outstanding = rows.reduce((s, i) => s + i.remaining, 0);

  return (
    <div className="stack">
      <h1>My Fees</h1>
      <p className="muted">Pay at the school counter or via bank. Total outstanding: <b>Rs {outstanding.toLocaleString()}</b>.</p>
      <table>
        <thead><tr><th>Period</th><th>Total</th><th>Paid</th><th>Remaining</th><th>Due</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.month ? `${r.month}/` : ''}{r.year}</td>
              <td>Rs {r.total.toLocaleString()}</td>
              <td>Rs {r.paid.toLocaleString()}</td>
              <td>Rs {r.remaining.toLocaleString()}</td>
              <td>{new Date(r.dueDate).toLocaleDateString()}</td>
              <td><span className={`badge ${badge(r.status)}`}>{r.status}</span></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={6} className="muted">No invoices yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
