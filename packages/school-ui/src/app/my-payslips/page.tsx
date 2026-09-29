'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type Payslip } from '@sw/api-client';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const rs = (n: number | string) => `Rs ${Math.round(Number(n)).toLocaleString()}`;

/**
 * My Payslips (Cash Payroll Plan).
 *
 * ⚠️ Only approved months arrive here — the API no longer returns drafts, which showed a figure the owner could
 * still change. Each row is named by its MONTH (it showed none) and says whether the salary has been handed over
 * yet, so "approved but I haven't been paid" is visible to the one person it matters to.
 */
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
      setMsg(e instanceof ApiError ? e.message : 'The payslip PDF is not available right now.');
    }
  }

  if (err) return <p className="error">Couldn&apos;t load your payslips.</p>;
  if (!rows) return <p className="muted">Loading…</p>;

  return (
    <div className="stack">
      <h1>My Payslips</h1>
      {msg && <div className="toast err">{msg}</div>}
      <div className="card stack">
        <table className="stacked">
          <thead><tr><th>Month</th><th style={{ textAlign: 'right' }}>Salary</th><th>Deductions</th><th style={{ textAlign: 'right' }}>Net pay</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {rows.map((p) => {
              const b = p.breakdown ?? {};
              const deduction = Number(p.attendanceDeduction) + Number(p.otherDeductions);
              const why = [
                b.unpaidLeaveDays ? `${b.unpaidLeaveDays} unpaid leave` : '',
                b.absentDays && b.deductForAbsence ? `${b.absentDays} absent` : '',
              ].filter(Boolean).join(', ');
              return (
                <tr key={p.id}>
                  <td data-label="Month"><strong>{MONTHS[p.month - 1]} {p.year}</strong></td>
                  <td data-label="Salary" style={{ textAlign: 'right' }}>{rs(p.gross)}</td>
                  <td data-label="Deductions">{deduction > 0 ? <>− {rs(deduction)}{why && <span className="muted"> ({why})</span>}</> : <span className="muted">None</span>}</td>
                  <td data-label="Net pay" style={{ textAlign: 'right' }}><strong>{rs(p.netPay)}</strong></td>
                  <td data-label="Status">
                    {p.state === 'PAID'
                      ? <span className="badge ok">Paid {p.paidAt ? new Date(p.paidAt).toLocaleDateString('en-GB') : ''}</span>
                      : <span className="badge warn">Approved · not paid yet</span>}
                  </td>
                  <td data-label="" style={{ textAlign: 'right' }}><button className="ghost small" onClick={() => openPdf(p.id)}>PDF</button></td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={6} className="muted">No payslips have been issued yet. They appear here once the school approves a month&apos;s payroll.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
