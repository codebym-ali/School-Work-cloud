'use client';

import { useState } from 'react';
import { apiGet, ApiError } from '@/lib/api';
import { useMe } from '@/lib/me-context';

const REPORTS: Array<{ key: string; label: string; params: string[]; financial?: boolean }> = [
  { key: 'daily-collection', label: 'Daily collection', params: ['date'], financial: true },
  { key: 'class-strength', label: 'Class strength', params: [] },
  { key: 'defaulters', label: 'Defaulters', params: ['minDays'], financial: true },
  { key: 'sms-usage', label: 'SMS usage', params: ['from', 'to'] },
  { key: 'fee-ledger', label: 'Fee ledger', params: ['studentId'], financial: true },
  { key: 'attendance-register', label: 'Attendance register', params: ['sectionId', 'from', 'to'] },
  { key: 'exam-summary', label: 'Exam summary', params: ['examId'] },
];

type Row = Record<string, unknown>;

export default function ReportsPage() {
  const me = useMe();
  const isAdmin = (me?.roles ?? []).some((r) => r === 'OWNER_ADMIN' || r === 'CAMPUS_ADMIN');
  const reports = isAdmin ? REPORTS : REPORTS.filter((r) => r.financial);

  const [key, setKey] = useState('daily-collection');
  const [params, setParams] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const spec = reports.find((r) => r.key === key) ?? reports[0];
  const query = () => {
    const q = Object.entries(params).filter(([k, v]) => spec.params.includes(k) && v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    return q ? `?${q}` : '';
  };

  async function run() {
    setErr(null); setRows(null);
    try { setRows(await apiGet<Row[]>(`/reports/${key}${query()}`)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed'); }
  }

  const csvHref = `/api/v1/reports/${key}${query() ? `${query()}&format=csv` : '?format=csv'}`;
  const headers = rows && rows.length ? Object.keys(rows[0]) : [];

  return (
    <div className="stack">
      <h1>Reports</h1>
      <div className="card stack">
        <div className="inline-form">
          <div><label>Report</label>
            <select value={key} onChange={(e) => { setKey(e.target.value); setRows(null); setErr(null); }}>
              {reports.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </div>
          {spec.params.map((p) => (
            <div key={p}><label>{p}</label>
              <input type={p === 'date' || p === 'from' || p === 'to' ? 'date' : 'text'} value={params[p] ?? ''} onChange={(e) => setParams({ ...params, [p]: e.target.value })} />
            </div>
          ))}
          <button onClick={run}>View</button>
          <a href={csvHref} className="ghost small" style={{ padding: '10px 16px', textDecoration: 'none' }}>Download CSV</a>
        </div>
        {spec.params.length > 0 && <p className="muted" style={{ margin: 0 }}>Leave params blank to use defaults where allowed.</p>}
      </div>

      {err && <div className="toast err">{err}</div>}
      {rows && (rows.length === 0 ? <p className="muted">No rows.</p> : (
        <table>
          <thead><tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => <tr key={i}>{headers.map((h) => <td key={h}>{String(r[h] ?? '')}</td>)}</tr>)}
          </tbody>
        </table>
      ))}
    </div>
  );
}
