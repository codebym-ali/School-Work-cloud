'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, ApiError, type StudentLeave } from '@/lib/api';
import { ChildNav } from '../child-nav';

const today = () => new Date().toISOString().slice(0, 10);
const badge = (s: string) => (s === 'APPROVED' ? 'ok' : s === 'PENDING' ? 'warn' : s === 'REJECTED' ? 'bad' : '');
const fmt = (d: string) => new Date(d).toLocaleDateString();

export default function ChildLeaves() {
  const { studentId } = useParams<{ studentId: string }>();
  const [rows, setRows] = useState<StudentLeave[] | null>(null);
  const [err, setErr] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [f, setF] = useState({ fromDate: today(), toDate: today(), reason: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setRows((await api.studentLeaves.list(studentId)).data); }
    catch { setErr(true); }
  }, [studentId]);
  useEffect(() => { load(); }, [load]);

  async function apply() {
    setBusy(true);
    setMsg(null);
    try {
      await api.studentLeaves.apply({ studentId, ...f });
      setF({ fromDate: today(), toDate: today(), reason: '' });
      setMsg({ ok: true, text: 'Leave request submitted.' });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to submit leave' });
    } finally { setBusy(false); }
  }

  async function cancel(id: string) {
    setMsg(null);
    try { await api.studentLeaves.cancel(id); setMsg({ ok: true, text: 'Leave cancelled.' }); await load(); }
    catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to cancel' }); }
  }

  const valid = f.reason.trim().length > 0 && f.fromDate <= f.toDate;

  return (
    <div className="stack">
      <ChildNav studentId={studentId} />
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      <div className="card stack">
        <h2 style={{ margin: 0, fontSize: 17 }}>Apply for leave</h2>
        <div className="inline-form">
          <div><label>From</label><input type="date" value={f.fromDate} onChange={(e) => setF({ ...f, fromDate: e.target.value })} /></div>
          <div><label>To</label><input type="date" value={f.toDate} onChange={(e) => setF({ ...f, toDate: e.target.value })} /></div>
          <div style={{ flex: 1, minWidth: 200 }}><label>Reason</label><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Brief reason" /></div>
          <button onClick={apply} disabled={!valid || busy}>Submit</button>
        </div>
        {f.fromDate > f.toDate && <p className="error" style={{ margin: 0 }}>The end date can&apos;t be before the start date.</p>}
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0, fontSize: 17 }}>Leave requests</h2>
        {err ? <p className="error">Couldn&apos;t load leaves.</p> : !rows ? <p className="muted">Loading…</p> : (
          <table>
            <thead><tr><th>From</th><th>To</th><th>Reason</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{fmt(r.fromDate)}</td>
                  <td>{fmt(r.toDate)}</td>
                  <td>{r.reason}{r.status === 'REJECTED' && r.rejectionReason && <span className="muted"> — {r.rejectionReason}</span>}</td>
                  <td><span className={`badge ${badge(r.status)}`}>{r.status}</span></td>
                  <td style={{ textAlign: 'right' }}>
                    {r.status === 'PENDING' && <button className="ghost small" onClick={() => cancel(r.id)}>Cancel</button>}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={5} className="muted">No leave requests yet.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
