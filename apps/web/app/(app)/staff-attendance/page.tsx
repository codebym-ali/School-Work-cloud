'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, type Campus, type StaffDaySummary, type StaffRegisterRow } from '@/lib/api';
import { useMe } from '@/lib/me-context';
import { attendanceBadge, humanizeStatus } from '@/lib/format';

const STATUSES = ['PRESENT', 'LATE', 'HALF_DAY', 'ON_LEAVE', 'ABSENT'] as const;
const today = () => new Date().toISOString().slice(0, 10);
const time = (t: string | null) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
const MARKED_BY: Record<string, string> = { SELF: 'Self', ADMIN: 'Office', SYSTEM: 'Auto' };

/**
 * The staff register for one day.
 *
 * Reached from the dashboard, pre-filtered — the filters live in the URL so the view is
 * shareable and survives the back button ("look at Tuesday's absences" should be a link).
 */
export default function StaffAttendancePage() {
  const me = useMe();
  const isOwner = (me?.roles ?? []).includes('OWNER_ADMIN');
  const canMark = (me?.roles ?? []).some((r) => r === 'OWNER_ADMIN' || r === 'CAMPUS_ADMIN');

  const [date, setDate] = useState(today());
  const [status, setStatus] = useState('');
  const [campusId, setCampusId] = useState('');
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [summary, setSummary] = useState<StaffDaySummary | null>(null);
  const [rows, setRows] = useState<StaffRegisterRow[] | null>(null);
  const [err, setErr] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState('');

  // Read the initial filters from the URL rather than useSearchParams, matching the pattern
  // used elsewhere in this app (no Suspense boundary needed for a client-only read).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('date')) setDate(q.get('date')!);
    if (q.get('status')) setStatus(q.get('status')!);
    if (q.get('campusId')) setCampusId(q.get('campusId')!);
    api.campuses.list().then(setCampuses).catch(() => setCampuses([]));
  }, []);

  const load = useCallback(async () => {
    const [s, r] = await Promise.all([
      api.staffAttendance.daySummary(date, campusId || undefined),
      api.staffAttendance.register({ date, status: status || undefined, campusId: campusId || undefined }),
    ]);
    setSummary(s);
    setRows(r);
  }, [date, status, campusId]);

  useEffect(() => {
    setRows(null);
    load().catch(() => setErr(true));
    const q = new URLSearchParams({ date, ...(status ? { status } : {}), ...(campusId ? { campusId } : {}) });
    window.history.replaceState(null, '', `?${q.toString()}`);
  }, [load, date, status, campusId]);

  async function setOne(staffId: string, next: string) {
    setBusy(staffId);
    try {
      const res = await api.staffAttendance.mark({ date, session: 'MORNING', records: [{ staffId, status: next }] });
      // The partial-failure contract: a refusal comes back in `errors`, not as a thrown error,
      // so a silent "saved" would be a lie.
      if (res.failed) setMsg({ ok: false, text: res.errors[0]?.message ?? 'Could not record that.' });
      else setMsg({ ok: true, text: 'Attendance recorded' });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not record that.' });
    } finally {
      setBusy('');
    }
  }

  if (err) return <p className="error">Couldn&apos;t load the staff register.</p>;

  return (
    <div className="stack">
      <div className="row">
        <h1 style={{ marginBottom: 0 }}>Staff attendance</h1>
        <span className="muted" style={{ fontSize: 13 }}>
          {summary?.workingDay === false
            ? summary.holidayName ? `${summary.holidayName} — no register today` : 'Weekly off — no register today'
            : 'Who is in today, and who nobody has marked yet'}
        </span>
      </div>

      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      <div className="inline-form">
        <div><label>Date</label><input type="date" max={today()} value={date} onChange={(e) => setDate(e.target.value)} /></div>
        {isOwner && campuses.length > 1 && (
          <div><label>Campus</label>
            <select value={campusId} onChange={(e) => setCampusId(e.target.value)}>
              <option value="">All campuses</option>
              {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
      </div>

      {summary && summary.workingDay && (
        <div className="grid">
          <div className="metric"><div className="value">{summary.totalStaff}</div><div className="label">Staff</div></div>
          <div className="metric"><div className="value">{summary.present + summary.late}</div><div className="label">Present</div></div>
          <div className={`metric${summary.absent > 0 ? ' metric-alert' : ''}`}>
            <div className="value">{summary.absent}</div><div className="label">Absent</div>
          </div>
          <div className="metric"><div className="value">{summary.onLeave}</div><div className="label">On leave</div></div>
          {/* Leads the eye where the work is: nothing writes an ABSENT row on its own, so a
              large "not marked" is the real state of the register, not a rounding detail. */}
          <div className={`metric${summary.unmarked > 0 ? ' metric-alert' : ''}`}
            title="Nobody has recorded anything for these people — not the same as being absent">
            <div className="value">{summary.unmarked}</div><div className="label">Not marked</div>
          </div>
        </div>
      )}

      <div className="chips">
        <button type="button" className={`chip${status === '' ? ' active' : ''}`} onClick={() => setStatus('')}>All</button>
        {STATUSES.map((s) => (
          <button key={s} type="button" className={`chip${status === s ? ' active' : ''}`} onClick={() => setStatus(s)}>
            {humanizeStatus(s)}
          </button>
        ))}
        <button type="button" className={`chip${status === 'UNMARKED' ? ' active' : ''}`} onClick={() => setStatus('UNMARKED')}>
          ⚠️ Not marked
        </button>
      </div>

      <div className="card stack">
        {!rows ? (
          <p className="muted" style={{ margin: 0 }}>Loading…</p>
        ) : rows.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {status ? 'Nobody matches this filter on this date.' : 'No staff records for this date.'}
          </p>
        ) : (
          <table>
            <thead>
              <tr><th>Name</th><th>Code</th><th>Campus</th><th>Status</th><th>Check-in</th><th>By</th>{canMark && <th>Record</th>}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.staffId}>
                  <td>
                    <Link href={`/staff-attendance/${r.staffId}`} style={{ fontWeight: 600 }}>{r.name}</Link>
                  </td>
                  <td className="muted">{r.employeeCode}</td>
                  <td className="muted">{r.campus ?? '—'}</td>
                  <td>
                    {r.status
                      ? <span className={`badge ${attendanceBadge(r.status)}`}>{humanizeStatus(r.status)}</span>
                      : <span className="badge warn">Not marked</span>}
                  </td>
                  <td>{time(r.checkIn)}</td>
                  <td className="muted">{r.source ? MARKED_BY[r.source] ?? r.source : '—'}</td>
                  {canMark && (
                    <td>
                      <select value="" disabled={busy === r.staffId}
                        onChange={(e) => { if (e.target.value) setOne(r.staffId, e.target.value); }}>
                        <option value="">{busy === r.staffId ? 'Saving…' : r.status ? 'Change…' : 'Record…'}</option>
                        {STATUSES.map((s) => <option key={s} value={s}>{humanizeStatus(s)}</option>)}
                      </select>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
