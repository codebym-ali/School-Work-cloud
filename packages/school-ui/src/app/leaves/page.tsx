'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type LeaveBalance, type StaffLeaveRow, type StudentLeaveRow } from '@sw/api-client';

/**
 * Leave approvals — the screen the dashboard has been advertising.
 *
 * The "Pending leaves" alert linked to Attendance, where nothing could be approved: the state
 * machine and both approve/reject endpoints existed, but no admin could reach them. A metric
 * that points at a page which cannot act on it is worse than no metric.
 *
 * Students and staff share one queue because they share one decision — approve or reject with a
 * reason — and an admin clearing the morning's requests should not have to know which list a
 * name lives in.
 */
type Kind = 'students' | 'staff';
const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;

const dateRange = (from: string, to: string) => {
  const f = new Date(from), t = new Date(to);
  const days = Math.round((t.getTime() - f.getTime()) / 86400000) + 1;
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return `${fmt(f)} – ${fmt(t)} · ${days} day${days === 1 ? '' : 's'}`;
};

const badgeFor = (status: string) =>
  status === 'APPROVED' ? 'ok' : status === 'REJECTED' ? 'bad' : status === 'CANCELLED' ? '' : 'warn';

export default function LeavesPage() {
  const [kind, setKind] = useState<Kind>('students');
  const [status, setStatus] = useState<string>('PENDING');
  const [students, setStudents] = useState<StudentLeaveRow[]>([]);
  const [staff, setStaff] = useState<StaffLeaveRow[]>([]);
  const [pendingCounts, setPendingCounts] = useState({ students: 0, staff: 0 });
  // Keyed by leave id, not staff id: the figure shown is priced over THAT request's range.
  const [cost, setCost] = useState<Record<string, LeaveBalance>>({});
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [st, sf] = await Promise.all([api.leaveQueue.students(status), api.leaveQueue.staff(status)]);
      setStudents(st.data);
      setStaff(sf.data);
      // Tab counts always reflect PENDING, whatever filter is showing — the badge answers
      // "what still needs me?", which does not change because you looked at last week's rejects.
      if (status === 'PENDING') setPendingCounts({ students: st.total, staff: sf.total });
      else {
        const [ps, pf] = await Promise.all([api.leaveQueue.students('PENDING'), api.leaveQueue.staff('PENDING')]);
        setPendingCounts({ students: ps.total, staff: pf.total });
      }
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not load leave requests' });
    }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  /**
   * Price every PENDING staff request that is on screen.
   *
   * Approving a staff leave is a decision about money — it can consume paid entitlement or be
   * deducted from salary — and the queue used to show only a name, a date range and a reason.
   * One request per pending row, which is what a morning's queue actually is; approved and
   * rejected rows are skipped because re-pricing a settled decision would show a hypothetical.
   */
  useEffect(() => {
    const pending = staff.filter((l) => l.status === 'PENDING' && !cost[l.id]);
    if (!pending.length) return;
    let live = true;
    (async () => {
      const priced = await Promise.all(pending.map(async (l) => {
        try { return [l.id, await api.leaveQueue.staffBalance(l.staffId, l)] as const; }
        catch { return null; } // a missing figure must not blank the queue you came here to clear
      }));
      if (!live) return;
      setCost((prev) => ({ ...prev, ...Object.fromEntries(priced.filter(Boolean) as Array<readonly [string, LeaveBalance]>) }));
    })();
    return () => { live = false; };
  }, [staff, cost]);

  async function act(id: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(id);
    setMsg(null);
    try {
      await fn();
      setRejecting(null);
      setReason('');
      await load();
      setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed' });
    } finally {
      setBusy('');
    }
  }

  const rows: Array<{ id: string; who: string; sub: string; range: string; reason: string; status: string; extra?: string; cost?: LeaveBalance; leaveType?: string }> =
    kind === 'students'
      ? students.map((l) => ({
          id: l.id,
          who: l.student?.fullName ?? 'Student',
          sub: l.student?.grNumber ? `GR ${l.student.grNumber}` : '',
          range: dateRange(l.fromDate, l.toDate),
          reason: l.reason,
          status: l.status,
          extra: l.rejectionReason ? `Rejected: ${l.rejectionReason}` : undefined,
        }))
      : staff.map((l) => ({
          id: l.id,
          who: l.staff?.fullName ?? l.staff?.employeeCode ?? 'Staff',
          sub: [l.leaveType, l.isUnpaid ? 'unpaid' : null].filter(Boolean).join(' · '),
          range: dateRange(l.fromDate, l.toDate),
          reason: l.reason,
          status: l.status,
          extra: l.rejectionReason ? `Rejected: ${l.rejectionReason}` : undefined,
          cost: cost[l.id],
          leaveType: l.leaveType,
        }));

  async function approve(id: string) {
    if (kind === 'students') return act(id, () => api.leaveQueue.approveStudent(id), 'Leave approved');
    // Approving staff leave also corrects days already marked ABSENT — otherwise the approval
    // changes nothing payroll can see. Say so, because a silent write to the attendance register
    // is exactly the kind of thing an office should be told about rather than discover.
    setBusy(id);
    setMsg(null);
    try {
      const res = await api.leaveQueue.approveStaff(id);
      setRejecting(null);
      setReason('');
      setCost((prev) => { const next = { ...prev }; delete next[id]; return next; });
      await load();
      setMsg({
        ok: true,
        text: res.attendanceCorrected > 0
          ? `Leave approved — ${res.attendanceCorrected} day${res.attendanceCorrected === 1 ? '' : 's'} already marked absent ${res.attendanceCorrected === 1 ? 'was' : 'were'} corrected to on-leave.`
          : 'Leave approved',
      });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed' });
    } finally {
      setBusy('');
    }
  }
  const reject = (id: string) =>
    act(id, () => (kind === 'students' ? api.leaveQueue.rejectStudent(id, reason.trim()) : api.leaveQueue.rejectStaff(id, reason.trim())), 'Leave rejected');

  return (
    <div className="stack">
      <h1>Leave requests</h1>
      <p className="muted" style={{ margin: 0 }}>
        Approve or reject leave for students and staff. Approving a student&apos;s leave marks
        those days ON LEAVE and locks them, so attendance can&apos;t contradict the decision.
      </p>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      <div className="row" style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
        <div className="chips">
          {(['students', 'staff'] as Kind[]).map((k) => (
            <button key={k} className={`chip ${kind === k ? 'active' : ''}`} onClick={() => { setKind(k); setRejecting(null); }}>
              {k === 'students' ? 'Students' : 'Staff'}
              {pendingCounts[k] > 0 && <span className="badge warn" style={{ marginLeft: 6 }}>{pendingCounts[k]}</span>}
            </button>
          ))}
        </div>
        <div style={{ maxWidth: 180 }}>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => <option key={s} value={s}>{s === 'PENDING' ? 'Awaiting decision' : s.charAt(0) + s.slice(1).toLowerCase()}</option>)}
          </select>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            {status === 'PENDING'
              ? `Nothing waiting — no ${kind === 'students' ? 'student' : 'staff'} leave needs a decision.`
              : `No ${status.toLowerCase()} requests.`}
          </p>
        </div>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {rows.map((r) => (
            <div key={r.id} className="card stack" style={{ gap: 6 }}>
              <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <strong>{r.who}</strong>
                  {r.sub && <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>{r.sub}</span>}
                  <div className="muted" style={{ fontSize: 13 }}>{r.range}</div>
                </div>
                <span className={`badge ${badgeFor(r.status)}`}>{r.status}</span>
              </div>

              <p style={{ margin: 0, fontSize: 14 }}>{r.reason}</p>
              {r.extra && <p className="muted" style={{ margin: 0, fontSize: 12 }}>{r.extra}</p>}

              {/* What approving this actually costs. Weekly offs and closures are already out of
                  the day count, so it is the number payroll will use, not a calendar span. */}
              {r.cost?.proposed && (() => {
                const p = r.cost!.proposed!;
                const bal = r.cost!.balances.find((b) => b.leaveType === r.leaveType);
                return (
                  <div className="chips" style={{ fontSize: 13 }}>
                    <span className={`badge ${p.wouldBeUnpaid ? 'warn' : 'ok'}`}>
                      {p.wouldBeUnpaid ? 'Unpaid if approved' : 'Paid leave'}
                    </span>
                    <span><strong>{p.workingDays}</strong> working day{p.workingDays === 1 ? '' : 's'}</span>
                    {bal && bal.entitlementDays != null && (
                      <span className="muted">
                        {bal.remainingDays} of {bal.entitlementDays} {bal.leaveType.toLowerCase()} days left this year
                      </span>
                    )}
                  </div>
                );
              })()}

              {r.status === 'PENDING' && (
                rejecting === r.id ? (
                  <div className="inline-form" style={{ alignItems: 'flex-end' }}>
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <label>Why is this rejected?</label>
                      {/* Required, because the person is told the reason — "no" without one is
                          the complaint every school office already gets. */}
                      <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
                        placeholder="Shown to the applicant" />
                    </div>
                    <button disabled={reason.trim().length < 3 || busy === r.id} onClick={() => reject(r.id)}>
                      {busy === r.id ? 'Rejecting…' : 'Confirm reject'}
                    </button>
                    <button className="ghost" onClick={() => { setRejecting(null); setReason(''); }}>Cancel</button>
                  </div>
                ) : (
                  <div className="row" style={{ justifyContent: 'flex-start', gap: 8 }}>
                    <button disabled={busy === r.id} onClick={() => approve(r.id)}>
                      {busy === r.id ? 'Approving…' : 'Approve'}
                    </button>
                    <button className="ghost" style={{ color: '#b91c1c' }} onClick={() => { setRejecting(r.id); setReason(''); }}>
                      Reject
                    </button>
                  </div>
                )
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
