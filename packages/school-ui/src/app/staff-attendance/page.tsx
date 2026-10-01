'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError, type StaffDaySummary, type StaffRegisterRow } from '@sw/api-client';
import { useCampusLens, useMe } from '@sw/session';
import { hasAnyRole } from '@sw/roles';
import { DateField } from '@school/components/date-field';
import { DataTable, EmptyState, KpiStrip, StatusPill, type Column, type KpiTileSpec, type Tone } from '@school/components/oversight';

/**
 * The staff register for one day (Owner UX Remediation Plan, Phase 1c).
 *
 * - The **office** marks it (campus admin, and the Ops Admin through the role hierarchy) — one tap per
 *   person with the paper register's letters, and **Mark all present** for everyone not yet marked.
 * - The **owner and HR** read it. The API refuses their writes; here they simply see no controls.
 * - Every count is its own filter: a tile and the list it opens can never disagree.
 */

const today = () => new Date().toISOString().slice(0, 10);
const time = (t: string | null) => (t ? new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—');
const MARKED_BY: Record<string, string> = { SELF: 'Self check-in', ADMIN: 'Office', SYSTEM: 'Automatic' };

/** The one status language: word + colour, in the order the office reads them. */
const STATUS: Record<string, { word: string; short: string; tone: Tone }> = {
  PRESENT: { word: 'Present', short: 'P', tone: 'ok' },
  LATE: { word: 'Late', short: 'L', tone: 'warn' },
  HALF_DAY: { word: 'Half day', short: '½', tone: 'warn' },
  ON_LEAVE: { word: 'On leave', short: 'Lv', tone: 'info' },
  ABSENT: { word: 'Absent', short: 'A', tone: 'bad' },
};
const MARKS = ['PRESENT', 'LATE', 'HALF_DAY', 'ON_LEAVE', 'ABSENT'] as const;

type Filter = '' | 'PRESENT' | 'LATE' | 'ABSENT' | 'ON_LEAVE' | 'UNMARKED';

/**
 * Owner and campus admin reach this inside the Attendance hub (`/attendance?tab=staff`); an old link to
 * `/staff-attendance` forwards there, date and filter kept. The HR manager has no hub, so for them this stays
 * a page of its own.
 */
export default function StaffAttendancePage({ embedded }: { embedded?: boolean }) {
  const me = useMe();
  const router = useRouter();
  const toHub = !embedded && hasAnyRole(me?.roles, ['OWNER_ADMIN', 'CAMPUS_ADMIN']);
  useEffect(() => {
    if (!toHub) return;
    const q = new URLSearchParams(window.location.search);
    const next = new URLSearchParams({ tab: 'staff', ...(q.get('date') ? { date: q.get('date')! } : {}), ...(q.get('status') ? { status: q.get('status')! } : {}) });
    router.replace(`/attendance?${next.toString()}`);
  }, [toHub, router]);
  if (toHub) return <p className="muted">Opening Attendance…</p>;
  return <StaffAttendanceScreen embedded={embedded} />;
}

function StaffAttendanceScreen({ embedded }: { embedded?: boolean }) {
  const me = useMe();
  // The office marks; the owner and HR oversee. Mirrors the API gate on POST /staff-attendance/bulk.
  const canMark = hasAnyRole(me?.roles, ['CAMPUS_ADMIN', 'OPERATIONS_ADMIN']);
  const lens = useCampusLens();
  const campusId = lens.campusId ?? '';
  // Seeded from the URL when the screen is CREATED, not in an effect: an effect that reads the URL races the
  // effect that writes it back, and in development (effects run twice) the second pass read a date the first had
  // already overwritten with today.
  const initialQuery = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search);
  const [date, setDate] = useState(() => (/^\d{4}-\d{2}-\d{2}$/.test(initialQuery?.get('date') ?? '') ? initialQuery!.get('date')! : today()));
  const [status, setStatus] = useState<Filter>(() => (initialQuery?.get('status') as Filter | null) ?? '');
  const [summary, setSummary] = useState<StaffDaySummary | null>(null);
  const [rows, setRows] = useState<StaffRegisterRow[] | null>(null);
  const [err, setErr] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string>('');

  // Filters live in the URL so "look at Tuesday's absences" is a link that survives Back.
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
    // Merge, don't replace: inside the hub the URL also carries `?tab=staff`, which must survive.
    const q = new URLSearchParams(window.location.search);
    q.set('date', date);
    if (status) q.set('status', status); else q.delete('status');
    window.history.replaceState(null, '', `?${q.toString()}`);
  }, [load, date, status, campusId]);

  async function record(records: Array<{ staffId: string; status: string }>, key: string, done: string) {
    setBusy(key); setMsg(null);
    try {
      const res = await api.staffAttendance.mark({ date, session: 'MORNING', records });
      // The partial-failure contract: refusals come back in `errors`, not as a thrown error.
      if (res.failed) setMsg({ ok: false, text: `${res.succeeded} recorded, ${res.failed} refused — ${res.errors[0]?.message ?? 'see the register'}` });
      else setMsg({ ok: true, text: done });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not record that.' });
    } finally {
      setBusy('');
    }
  }

  if (err) return <EmptyState title="Couldn’t load the staff register">Refresh the page to try again.</EmptyState>;

  const s = summary;
  const inToday = s ? s.present + s.late + s.halfDay : 0;
  const markedCount = s ? s.totalStaff - s.unmarked : 0;
  const num = (v: number | undefined) => (v === undefined ? undefined : String(v));
  const pick = (f: Filter) => setStatus((cur) => (cur === f ? '' : f));
  const tiles: KpiTileSpec[] = [
    // "today" only when it IS today — stepping back to Monday must not keep saying "In today".
    { key: 'in', label: date === today() ? 'In today' : 'In that day', icon: 'check-circle', tone: 'ok',
      value: !s ? undefined : !s.workingDay ? 'Closed' : markedCount === 0 ? '—' : `${Math.round((inToday / markedCount) * 100)}%`,
      sub: !s ? undefined : !s.workingDay ? (s.holidayName ?? 'Weekly off') : `${inToday} of ${s.totalStaff} staff${s.late ? ` · ${s.late} late` : ''}`,
      active: status === '', onClick: () => setStatus(''), hint: 'Everyone on the register' },
    { key: 'PRESENT', label: 'On time', icon: 'check-circle', tone: 'ok', value: num(s?.present), active: status === 'PRESENT', onClick: () => pick('PRESENT') },
    { key: 'LATE', label: 'Late', icon: 'timetable', tone: s && s.late > 0 ? 'warn' : 'neutral', value: num(s?.late), active: status === 'LATE', onClick: () => pick('LATE') },
    { key: 'ABSENT', label: 'Absent', icon: 'x-circle', tone: s && s.absent > 0 ? 'bad' : 'neutral', value: num(s?.absent), active: status === 'ABSENT', onClick: () => pick('ABSENT') },
    { key: 'ON_LEAVE', label: 'On leave', icon: 'leave', tone: 'info', value: num(s?.onLeave), active: status === 'ON_LEAVE', onClick: () => pick('ON_LEAVE') },
    { key: 'UNMARKED', label: 'Not marked', icon: 'alert', tone: s && s.unmarked > 0 ? 'bad' : 'ok', value: num(s?.unmarked),
      sub: s && s.selfMarked > 0 ? `${s.selfMarked} checked in themselves` : undefined,
      active: status === 'UNMARKED', onClick: () => pick('UNMARKED'), hint: 'Nobody has recorded anything for these people — not the same as absent' },
  ];

  const unmarkedRows = (rows ?? []).filter((r) => !r.status);
  const columns: Column<StaffRegisterRow>[] = [
    { key: 'name', header: 'Staff member', pinned: true, sortValue: (r) => r.name, cell: (r) => (
      <span className="ov-person-text">
        <Link href={`/staff-attendance/${r.staffId}`} style={{ fontWeight: 600 }}>{r.name}</Link>
        <span className="ov-sub">{r.employeeCode}{r.campus ? ` · ${r.campus}` : ''}</span>
      </span>
    ) },
    { key: 'status', header: 'Status', sortValue: (r) => (r.status ? STATUS[r.status]?.word : 'ZZ'), cell: (r) => (r.status
      ? <StatusPill tone={STATUS[r.status]?.tone ?? 'neutral'}>{STATUS[r.status]?.word ?? r.status}</StatusPill>
      : <StatusPill tone="neutral">Not marked</StatusPill>) },
    { key: 'in', header: 'Check-in', sortValue: (r) => r.checkIn, cell: (r) => <span className="ov-num" style={{ fontWeight: 400 }}>{time(r.checkIn)}</span> },
    { key: 'by', header: 'Recorded by', sortValue: (r) => r.source, cell: (r) => <span className="ov-sub">{r.source ? MARKED_BY[r.source] ?? r.source : '—'}</span> },
    ...(canMark && s?.workingDay !== false ? [{
      key: 'mark', header: 'Record', pinned: true, cell: (r: StaffRegisterRow) => (
        <span className="ov-segmark" role="group" aria-label={`Record ${r.name}`}>
          {MARKS.map((m) => (
            <button key={m} type="button" className={`ov-mark${r.status === m ? ` is-on is-${STATUS[m]!.tone}` : ''}`}
              aria-pressed={r.status === m} title={STATUS[m]!.word} aria-label={`${STATUS[m]!.word}: ${r.name}`}
              disabled={!!busy} onClick={() => { if (r.status !== m) void record([{ staffId: r.staffId, status: m }], r.staffId, `${r.name}: ${STATUS[m]!.word.toLowerCase()}`); }}>
              {STATUS[m]!.short}
            </button>
          ))}
        </span>
      ),
    } satisfies Column<StaffRegisterRow>] : []),
  ];

  return (
    <div className="oh">
      <div className="ov-head">
        <div>
          {!embedded && <h1 style={{ margin: 0 }}>Staff attendance</h1>}
          <p className="ov-lede">
            {summary?.workingDay === false
              ? `${summary.holidayName ?? 'Weekly off'} — no register on this day.`
              : canMark ? 'Who is in today. Tap a letter to record someone; nobody is marked absent automatically.'
                : 'View only — the office records staff attendance.'}
          </p>
        </div>
        <div className="ov-field" style={{ minWidth: 0 }}>
          <label htmlFor="staff-att-date" style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Date</label>
          <DateField id="staff-att-date" value={date} max={today()} onChange={setDate} />
        </div>
      </div>

      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`} role="status">{msg.text}</div>}

      <KpiStrip label="Staff today" tiles={tiles} />

      <DataTable<StaffRegisterRow>
        caption="Staff register"
        noun="staff"
        columns={columns}
        rows={rows ?? []}
        rowKey={(r) => r.staffId}
        loading={!rows}
        initialSort={{ key: 'name', dir: 'asc' }}
        toolbar={canMark && summary?.workingDay && unmarkedRows.length > 0 && status !== 'ABSENT' && status !== 'ON_LEAVE' ? (
          <button type="button" className="ov-btn-primary" disabled={!!busy}
            onClick={() => void record(unmarkedRows.map((r) => ({ staffId: r.staffId, status: 'PRESENT' })), 'ALL',
              `${unmarkedRows.length} marked present`)}>
            {busy === 'ALL' ? 'Saving…' : `Mark ${unmarkedRows.length} not-marked as present`}
          </button>
        ) : status ? (
          <span className="ov-filter-chip">Showing: <strong>{tiles.find((t) => t.key === status)?.label}</strong>
            <button type="button" className="ov-link" onClick={() => setStatus('')}>Show everyone</button></span>
        ) : undefined}
        empty={<EmptyState title={status ? 'Nobody matches this filter on this date' : 'No staff on the register for this date'}>
          {status ? 'Choose another tile or date.' : 'Staff appear here from the day they join.'}
        </EmptyState>}
      />
    </div>
  );
}
