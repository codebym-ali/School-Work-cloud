'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type LeaveBalance, type StaffLeave } from '@/lib/api';

/**
 * My Leaves — for STAFF and TEACHER (§10).
 *
 * The screen is built around the **balance**, not the form. The quota decides whether a leave is
 * paid, and until now it was invisible: the server silently stamped a request UNPAID and the
 * person found out a month later, on their payslip. A rule that moves someone's salary has to be
 * legible before it is applied, so the entitlement is the first thing on the page and the cost of
 * what you are about to submit is shown while you pick the dates.
 *
 * Every number here is the **server's**. The working-day count and the paid/unpaid verdict come
 * from `/staff-leaves/balance`, priced by the same function that stamps the real request — the
 * browser deliberately does not own a copy of the school calendar, because two copies is how the
 * warning and the outcome end up disagreeing about someone's pay.
 */
const TYPES = ['CASUAL', 'SICK', 'UNPAID', 'OTHER'];
const today = () => new Date().toISOString().slice(0, 10);
const badge = (s: string) => (s === 'APPROVED' ? 'ok' : s === 'PENDING' ? 'warn' : s === 'REJECTED' ? 'bad' : '');
const fmt = (d: string) => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const title = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

/** Inclusive calendar span, only ever shown next to the server's working-day count to explain
 *  the difference — never used to decide anything. */
const calendarSpan = (from: string, to: string) =>
  Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1;

export default function MyLeaves() {
  const [rows, setRows] = useState<StaffLeave[] | null>(null);
  const [balance, setBalance] = useState<LeaveBalance | null>(null);
  const [quote, setQuote] = useState<LeaveBalance['proposed'] | 'loading' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [f, setF] = useState({ leaveType: 'CASUAL', fromDate: today(), toDate: today(), reason: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [mine, bal] = await Promise.all([api.staffLeaves.mine(), api.staffLeaves.balance()]);
      setRows(mine.data);
      setBalance(bal);
    } catch (e) {
      // A staff profile is what makes this page mean anything; without one the server 403s, and
      // saying so is more use than "couldn't load".
      setErr(e instanceof ApiError ? e.message : 'Could not load your leaves.');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Price the range being composed. Debounced because it moves on every keystroke in a date box,
  // and skipped entirely when the range is backwards — the server would only refuse it.
  const datesValid = f.fromDate <= f.toDate;
  useEffect(() => {
    if (!datesValid) { setQuote(null); return; }
    setQuote('loading');
    const t = setTimeout(async () => {
      try {
        const bal = await api.staffLeaves.balance({ leaveType: f.leaveType, fromDate: f.fromDate, toDate: f.toDate });
        setQuote(bal.proposed);
      } catch { setQuote(null); }
    }, 350);
    return () => clearTimeout(t);
  }, [f.leaveType, f.fromDate, f.toDate, datesValid]);

  async function apply() {
    setBusy(true);
    setMsg(null);
    try {
      await api.staffLeaves.apply(f);
      setF({ leaveType: 'CASUAL', fromDate: today(), toDate: today(), reason: '' });
      setMsg({ ok: true, text: 'Leave request submitted. You will be told once it is decided.' });
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

  if (err) return <p className="error">{err}</p>;

  const valid = f.reason.trim().length > 0 && datesValid;
  const span = datesValid ? calendarSpan(f.fromDate, f.toDate) : 0;

  return (
    <div className="stack">
      <h1>My Leaves</h1>

      {balance && (
        <p className="muted" style={{ margin: 0 }}>
          Entitlement year {fmt(balance.windowStart)} – {fmt(balance.windowEnd)}. Weekly offs and
          school closures inside a leave are not counted against you.
        </p>
      )}
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {balance && (
        <div>
          <div className="section-title">Your balance</div>
          <div className="grid">
            {balance.balances.map((b) => (
              <div key={b.leaveType} className="metric">
                {/* An unset quota is "no limit", not "nothing left" — showing 0 for it would tell
                    someone they had run out of a leave type the school never capped. */}
                <div className="value">{b.entitlementDays == null ? '—' : b.remainingDays}</div>
                <div className="label">
                  <strong>{title(b.leaveType)}</strong>
                  <br />
                  {b.entitlementDays == null
                    ? b.leaveType === 'UNPAID' ? 'Always unpaid' : 'No limit set'
                    : `${b.remainingDays} of ${b.entitlementDays} days left`}
                  {b.pendingDays > 0 && <><br /><span style={{ color: '#b45309' }}>{b.pendingDays} day{b.pendingDays === 1 ? '' : 's'} awaiting a decision</span></>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card stack">
        <h2 style={{ margin: 0, fontSize: 17 }}>Apply for leave</h2>
        <div className="inline-form">
          <div><label>Type</label>
            <select value={f.leaveType} onChange={(e) => setF({ ...f, leaveType: e.target.value })}>
              {TYPES.map((t) => <option key={t} value={t}>{title(t)}</option>)}
            </select>
          </div>
          <div><label>From</label><input type="date" value={f.fromDate} onChange={(e) => setF({ ...f, fromDate: e.target.value })} /></div>
          <div><label>To</label><input type="date" value={f.toDate} onChange={(e) => setF({ ...f, toDate: e.target.value })} /></div>
          <div style={{ flex: 1, minWidth: 200 }}><label>Reason</label><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Brief reason" /></div>
          <button onClick={apply} disabled={!valid || busy}>{busy ? 'Submitting…' : 'Submit'}</button>
        </div>

        {!datesValid && <p className="error" style={{ margin: 0 }}>The end date can&apos;t be before the start date.</p>}

        {/* The whole point of the screen: you are told what this costs BEFORE you submit it,
            not after it reaches your payslip. */}
        {datesValid && quote === 'loading' && <p className="muted" style={{ margin: 0, fontSize: 13 }}>Working out what this costs…</p>}
        {datesValid && quote && quote !== 'loading' && (
          <div className="stack" style={{ gap: 4 }}>
            <div className="chips">
              <span className={`badge ${quote.wouldBeUnpaid ? 'warn' : 'ok'}`}>
                {quote.wouldBeUnpaid ? 'Will be UNPAID' : 'Will be paid'}
              </span>
              <span style={{ fontSize: 13 }}>
                <strong>{quote.workingDays}</strong> working day{quote.workingDays === 1 ? '' : 's'}
                {span !== quote.workingDays && <span className="muted"> ({span} calendar days — weekly offs and closures excluded)</span>}
              </span>
            </div>
            {quote.wouldBeUnpaid && (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                {f.leaveType === 'UNPAID'
                  ? 'Unpaid leave is deducted from salary whatever the school\'s absence setting is.'
                  : `This goes past your ${title(f.leaveType)} balance, so it will be deducted from salary. Ask the office if you think that is wrong.`}
              </p>
            )}
            {quote.workingDays === 0 && (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                Every day you picked is already a weekly off or a school closure — you do not need leave for these.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0, fontSize: 17 }}>My requests</h2>
        {!rows ? <p className="muted">Loading…</p> : (
          <table className="stacked">
            <thead><tr><th>Type</th><th>From</th><th>To</th><th>Reason</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td data-label="Type">{title(r.leaveType)}{r.isUnpaid && <span className="badge warn" style={{ marginLeft: 6 }}>unpaid</span>}</td>
                  <td data-label="From">{fmt(r.fromDate)}</td>
                  <td data-label="To">{fmt(r.toDate)}</td>
                  <td data-label="">{r.reason}{r.status === 'REJECTED' && r.rejectionReason && <span className="muted"> — {r.rejectionReason}</span>}</td>
                  <td data-label="Status"><span className={`badge ${badge(r.status)}`}>{r.status}</span></td>
                  <td data-label="" style={{ textAlign: 'right' }}>
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
