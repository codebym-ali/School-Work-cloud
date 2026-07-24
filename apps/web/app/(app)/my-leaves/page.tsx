'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type StaffLeave } from '@/lib/api';

const TYPES = ['CASUAL', 'SICK', 'UNPAID', 'OTHER'];
const today = () => new Date().toISOString().slice(0, 10);
const badge = (s: string) => (s === 'APPROVED' ? 'ok' : s === 'PENDING' ? 'warn' : s === 'REJECTED' ? 'bad' : '');
const fmt = (d: string) => new Date(d).toLocaleDateString();

export default function MyLeaves() {
  const [rows, setRows] = useState<StaffLeave[] | null>(null);
  const [err, setErr] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [f, setF] = useState({ leaveType: 'CASUAL', fromDate: today(), toDate: today(), reason: '' });
  const [busy, setBusy] = useState(false);

  async function load() {
    try { setRows((await api.staffLeaves.mine()).data); }
    catch { setErr(true); }
  }
  useEffect(() => { load(); }, []);

  async function apply() {
    setBusy(true);
    setMsg(null);
    try {
      await api.staffLeaves.apply(f);
      setF({ leaveType: 'CASUAL', fromDate: today(), toDate: today(), reason: '' });
      setMsg({ ok: true, text: 'Leave request submitted.' });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to submit leave' });
    } finally { setBusy(false); }
  }

  async function cancel(id: string) {
    setMsg(null);
    try { await api.staffLeaves.cancel(id); setMsg({ ok: true, text: 'Leave cancelled.' }); await load(); }
    catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to cancel' }); }
  }

  if (err) return <p className="error">Couldn&apos;t load your leaves.</p>;

  const valid = f.reason.trim().length > 0 && f.fromDate <= f.toDate;

  return (
    <div className="stack">
      <h1>My Leaves</h1>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      <div className="card stack">
        <h2 style={{ margin: 0, fontSize: 17 }}>Apply for leave</h2>
        <div className="inline-form">
          <div><label>Type</label>
            <select value={f.leaveType} onChange={(e) => setF({ ...f, leaveType: e.target.value })}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div><label>From</label><input type="date" value={f.fromDate} onChange={(e) => setF({ ...f, fromDate: e.target.value })} /></div>
          <div><label>To</label><input type="date" value={f.toDate} onChange={(e) => setF({ ...f, toDate: e.target.value })} /></div>
          <div style={{ flex: 1, minWidth: 200 }}><label>Reason</label><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Brief reason" /></div>
          <button onClick={apply} disabled={!valid || busy}>Submit</button>
        </div>
        {f.fromDate > f.toDate && <p className="error" style={{ margin: 0 }}>The end date can&apos;t be before the start date.</p>}
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0, fontSize: 17 }}>My requests</h2>
        {!rows ? <p className="muted">Loading…</p> : (
          <table>
            <thead><tr><th>Type</th><th>From</th><th>To</th><th>Reason</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.leaveType}{r.isUnpaid && <span className="badge" style={{ marginLeft: 6 }}>unpaid</span>}</td>
                  <td>{fmt(r.fromDate)}</td>
                  <td>{fmt(r.toDate)}</td>
                  <td>{r.reason}{r.status === 'REJECTED' && r.rejectionReason && <span className="muted"> — {r.rejectionReason}</span>}</td>
                  <td><span className={`badge ${badge(r.status)}`}>{r.status}</span></td>
                  <td style={{ textAlign: 'right' }}>
                    {r.status === 'PENDING' && <button className="ghost small" onClick={() => cancel(r.id)}>Cancel</button>}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6} className="muted">No leave requests yet.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
