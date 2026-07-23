'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type Payslip } from '@/lib/api';

const badge = (s: string) => (s === 'PAID' ? 'ok' : s === 'APPROVED' ? 'warn' : '');

export default function MyPayslips() {
  const [rows, setRows] = useState<Payslip[] | null>(null);
  const [err, setErr] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { api.payslips.mine().then(setRows).catch(() => setErr(true)); }, []);

  async function openPdf(id: string) {
    setMsg(null);
    try {
      const { url } = await api.payslips.pdf(id);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Payslip PDF is not available yet');
    }
  }

  if (err) return <p className="error">Couldn&apos;t load your payslips.</p>;
  if (!rows) return <p className="muted">Loading…</p>;

  return (
    <div className="stack">
      <h1>My Payslips</h1>
      {msg && <div className="toast err">{msg}</div>}
      <div className="card stack">
        <table>
          <thead><tr><th>Gross</th><th>Deductions</th><th>Net pay</th><th>Status</th><th>Paid on</th><th></th></tr></thead>
          <tbody>
            {rows.map((p) => {
              const deductions = Number(p.attendanceDeduction) + Number(p.otherDeductions);
              return (
                <tr key={p.id}>
                  <td>Rs {Number(p.gross).toLocaleString()}</td>
                  <td>Rs {deductions.toLocaleString()}</td>
                  <td>Rs {Number(p.netPay).toLocaleString()}</td>
                  <td><span className={`badge ${badge(p.status)}`}>{p.status}</span></td>
                  <td className="muted">{p.paidAt ? new Date(p.paidAt).toLocaleDateString() : '—'}</td>
                  <td style={{ textAlign: 'right' }}><button className="ghost small" onClick={() => openPdf(p.id)}>PDF</button></td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={6} className="muted">No payslips yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
