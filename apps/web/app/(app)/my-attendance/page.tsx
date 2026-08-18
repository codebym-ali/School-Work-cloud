'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type CheckInState, type StaffAttendanceRow, type StaffAttendanceSummary } from '@/lib/api';
import { attendanceBadge, humanizeStatus } from '@/lib/format';
import { Metric, MetricFilter } from '@/components/metric';
import { RANGE_OPTIONS, rangeQuery, type RangeKey } from '@/lib/date-ranges';

const time = (t: string | null) =>
  t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';

/** Who recorded a day. A staff member must be able to see that the office (or the system)
 *  wrote something against them, or they cannot dispute it. */
/**
 * Which kind of day the table is narrowed to.
 *
 * ⚠️ `present` covers PRESENT **and** LATE, because the tile above it counts both — a late arrival
 * is still a full day for the percentage. The mapping lives here once so the number and the list
 * are the same set rather than two definitions that happen to match today.
 */
type DayFocus = '' | 'present' | 'absent' | 'leave';
const FOCUS_STATUSES: Record<Exclude<DayFocus, ''>, readonly string[]> = {
  present: ['PRESENT', 'LATE'],
  absent: ['ABSENT'],
  leave: ['ON_LEAVE'],
};

const MARKED_BY: Record<string, string> = { SELF: 'You', ADMIN: 'Office', SYSTEM: 'Auto' };

export default function MyAttendance() {
  const [range, setRange] = useState<RangeKey>('3m');
  const [rows, setRows] = useState<StaffAttendanceRow[] | null>(null);
  const [focus, setFocus] = useState<DayFocus>('');
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

  const visibleRows = (rows ?? []).filter(
    (r) => !focus || FOCUS_STATUSES[focus].includes(r.status),
  );

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
          <Metric label="Attendance" value={summary.percent == null ? '—' : `${summary.percent}%`} />
          {/* Late still counts as a full day for the percentage, so it belongs in this total —
              but the label must say so. A "Days present" figure that silently absorbs late
              arrivals is the same lie the register's tiles used to tell. The FILTER absorbs them
              identically, from the same set, so the count and the list cannot part company. */}
          <MetricFilter
            label={`Days present${summary.late > 0 ? ` (${summary.late} late)` : ''}`}
            value={summary.present + summary.late}
            active={focus === 'present'} title="Late arrivals count as a full day"
            onClick={() => setFocus(focus === 'present' ? '' : 'present')} />
          {/* A count, not just a percentage: "3 absent" is actionable, "94%" is not. */}
          <MetricFilter label="Days absent" value={summary.absent} alert={summary.absent > 0}
            active={focus === 'absent'} onClick={() => setFocus(focus === 'absent' ? '' : 'absent')} />
          <MetricFilter label="On leave" value={summary.onLeave}
            active={focus === 'leave'} onClick={() => setFocus(focus === 'leave' ? '' : 'leave')} />
          {/* ⚠️ Never folded into "absent" — a day nobody marked is not a day you missed — and
              deliberately NOT a filter: an unmarked day has no record, so there is no row to show.
              Clicking it would put "3" above an empty table, which is the precise disagreement
              between a count and its list that these components exist to prevent. */}
          <Metric label="Not marked" value={summary.unmarked} alert={false} />
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
          <table className="stacked">
            <thead><tr><th>Date</th><th>Status</th><th>Check-in</th><th>Marked by</th></tr></thead>
            <tbody>
              {visibleRows.map((r, i) => (
                <tr key={i}>
                  <td data-label="Date">{new Date(r.date).toLocaleDateString()}</td>
                  <td data-label="Status"><span className={`badge ${attendanceBadge(r.status)}`}>{humanizeStatus(r.status)}</span></td>
                  <td data-label="Check-in">{time(r.checkIn)}</td>
                  <td data-label="Marked by" className="muted">{MARKED_BY[r.source] ?? r.source}</td>
                </tr>
              ))}
              {visibleRows.length === 0 && (
                <tr><td colSpan={4} className="muted">
                  {focus ? 'No days of that kind in this period.' : 'No attendance recorded in this period.'}
                </td></tr>
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
    // Say WHICH. "A holiday or weekly off" leaves a teacher unsure whether the button is broken
    // or the school is shut — and those need very different reactions.
    return (
      <span className="muted" style={{ fontSize: 13 }}>
        {state.closedFor
          ? `School is closed today — ${state.closedFor}. No attendance is taken.`
          : 'Today is a weekly off — no attendance is taken.'}
      </span>
    );
  }
  if (state.today) {
    // A row the day-close job wrote is not something this person did. It used to render as a
    // green `badge ok` reading "Already marked Absent today" — a success colour on an absence,
    // phrased as though they had done it, with no hint that the remedy is the office rather than
    // the button. Name the author, and only call it OK when it actually is.
    const machineWrote = state.today.source === 'SYSTEM';
    const good = state.today.status === 'PRESENT' || state.today.status === 'LATE';
    return (
      <span className={`badge ${good ? 'ok' : 'bad'}`} style={{ fontSize: 13 }}>
        {state.today.checkIn
          ? `Checked in at ${time(state.today.checkIn)}`
          : machineWrote
            ? `Recorded ${humanizeStatus(state.today.status)} when the register closed${state.closeAtTime ? ` at ${state.closeAtTime}` : ''} — ask the office to correct it`
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
      {/* State the deadline while it can still be met. Discovering it by missing it is how the
          old fleet-wide 20:00 turned into "the button just refuses me". */}
      {state.closeAtTime && (
        <span className="muted" style={{ fontSize: 12 }}>
          Check in before {state.closeAtTime}
        </span>
      )}
    </div>
  );
}
