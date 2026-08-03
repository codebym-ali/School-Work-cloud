'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type CheckInState, type StaffAttendanceRow, type StaffAttendanceSummary } from '@/lib/api';
import { attendanceBadge, humanizeStatus } from '@/lib/format';
import { RANGE_OPTIONS, rangeQuery, type RangeKey } from '@/lib/date-ranges';

const time = (t: string | null) =>
  t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';

/** Who recorded a day. A staff member must be able to see that the office (or the system)
 *  wrote something against them, or they cannot dispute it. */
const MARKED_BY: Record<string, string> = { SELF: 'You', ADMIN: 'Office', SYSTEM: 'Auto' };

export default function MyAttendance() {
  const [range, setRange] = useState<RangeKey>('3m');
  const [rows, setRows] = useState<StaffAttendanceRow[] | null>(null);
  const [summary, setSummary] = useState<StaffAttendanceSummary | null>(null);
  const [checkState, setCheckState] = useState<CheckInState | null>(null);
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const qs = rangeQuery(range);
    const [r, s] = await Promise.all([api.staff.myAttendance(qs), api.staff.myAttendanceSummary(qs)]);
    setRows(r);
    setSummary(s);
  }, [range]);

  useEffect(() => {
    setRows(null);
    load().catch(() => setErr(true));
  }, [load]);

  // Separate from the history: whether the button should appear is about today, not the range.
  useEffect(() => {
    api.staff.checkInState().then(setCheckState).catch(() => setCheckState(null));
  }, []);

  async function checkIn() {
    setBusy(true);
    try {
      const res = await api.staff.checkIn();
      setMsg({ ok: true, text: `Checked in at ${time(res.checkIn)} — marked ${humanizeStatus(res.status)}.` });
      setCheckState(await api.staff.checkInState());
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not check you in.' });
    } finally {
      setBusy(false);
    }
  }

  if (err) return <p className="error">Couldn&apos;t load your attendance.</p>;

  return (
    <div className="stack">
      <div className="row">
        <h1 style={{ marginBottom: 0 }}>My Attendance</h1>
        {checkState?.enabled && <CheckInControl state={checkState} busy={busy} onCheckIn={checkIn} />}
      </div>

      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      <div className="chips">
        {RANGE_OPTIONS.filter((o) => o.key !== 'all').map((o) => (
          <button key={o.key} type="button" className={`chip${range === o.key ? ' active' : ''}`}
            onClick={() => setRange(o.key)}>
            {o.label}
          </button>
        ))}
      </div>

      {summary && (
        <div className="grid">
          <div className="metric" title="Present and late count in full, half days count half; approved leave is excluded entirely">
            <div className="value">{summary.percent == null ? '—' : `${summary.percent}%`}</div>
            <div className="label">Attendance</div>
          </div>
          <div className="metric"><div className="value">{summary.present + summary.late}</div><div className="label">Days present</div></div>
          {/* A count, not just a percentage: "3 absent" is actionable, "94%" is not. */}
          <div className={`metric${summary.absent > 0 ? ' metric-alert' : ''}`}>
            <div className="value">{summary.absent}</div><div className="label">Days absent</div>
          </div>
          <div className="metric"><div className="value">{summary.onLeave}</div><div className="label">On leave</div></div>
          {/* Never folded into "absent" — a day nobody marked is not a day you missed. */}
          <div className="metric" title="Working days in this period with no attendance recorded at all">
            <div className="value">{summary.unmarked}</div><div className="label">Not marked</div>
          </div>
        </div>
      )}

      <div className="card stack">
        <div className="row">
          <h2 style={{ margin: 0, fontSize: 17 }}>Records</h2>
          {summary && (
            <span className="muted" style={{ fontSize: 12 }}>
              {summary.from} → {summary.to} · {summary.marked} of {summary.workingDays} working days
            </span>
          )}
        </div>
        {!rows ? (
          <p className="muted" style={{ margin: 0 }}>Loading…</p>
        ) : (
          <table>
            <thead><tr><th>Date</th><th>Status</th><th>Check-in</th><th>Marked by</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{new Date(r.date).toLocaleDateString()}</td>
                  <td><span className={`badge ${attendanceBadge(r.status)}`}>{humanizeStatus(r.status)}</span></td>
                  <td>{time(r.checkIn)}</td>
                  <td className="muted">{MARKED_BY[r.source] ?? r.source}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={4} className="muted">No attendance recorded in this period.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/**
 * One button, and a receipt once pressed — not a toggle, because there is nothing to undo.
 *
 * Being late is announced BEFORE the click. Springing it afterwards would make the button feel
 * like a trap, and the teacher cannot choose the outcome anyway: the server reads the clock.
 */
function CheckInControl({ state, busy, onCheckIn }: { state: CheckInState; busy: boolean; onCheckIn: () => void }) {
  if (state.nonWorkingDay) {
    return <span className="muted" style={{ fontSize: 13 }}>Today is a holiday or weekly off — no attendance is taken.</span>;
  }
  if (state.today) {
    return (
      <span className="badge ok" style={{ fontSize: 13 }}>
        {state.today.checkIn
          ? `Checked in at ${time(state.today.checkIn)}`
          : `Already marked ${humanizeStatus(state.today.status)} today`}
      </span>
    );
  }
  const late = state.wouldBe === 'LATE';
  return (
    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
      {late && (
        <span className="muted" style={{ fontSize: 12 }}>
          The day started at {state.dayStartTime}
        </span>
      )}
      <button type="button" disabled={busy} onClick={onCheckIn}>
        {busy ? 'Checking in…' : late ? "✓ Check in (you're late)" : '✓ Check in'}
      </button>
    </div>
  );
}
