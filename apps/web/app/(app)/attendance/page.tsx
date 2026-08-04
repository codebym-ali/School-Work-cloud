'use client';

import { useEffect, useState } from 'react';
import { api, apiGet, apiPost, ApiError, type Campus, type Enrollment, type Klass, type Section, type UnmarkedRegisters } from '@/lib/api';
import { sectionLabeller } from '@/lib/labels';

interface DayCoverage { date: string; working: boolean; marked: number; expected: number }

const STATUSES = ['PRESENT', 'ABSENT', 'LATE', 'HALF_DAY'];
const today = () => new Date().toISOString().slice(0, 10);
/** Mirrors the server's `attendanceBackfillDays` (default 7). Bounding the picker means the
 *  rule is visible as a disabled date rather than discovered as a rejected save. */
const BACKFILL_DAYS = 7;
const earliest = () => {
  const d = new Date();
  d.setDate(d.getDate() - BACKFILL_DAYS);
  return d.toISOString().slice(0, 10);
};

/**
 * The last 7 days at a glance, so a teacher can SEE which days are unmarked instead of
 * remembering them. Backfill without this is technically possible and practically unused —
 * nobody navigates date by date on the chance a day is missing.
 *
 * Non-working days are shown as "off", never as gaps: a strip that flags every Sunday is a
 * strip that gets ignored. A partly-marked day is called out separately from an untouched one
 * because they are different problems — one was interrupted, the other never started.
 */
function CoverageStrip({ days, selected, onPick }: {
  days: DayCoverage[]; selected: string; onPick: (date: string) => void;
}) {
  if (!days.length) return null;
  const gaps = days.filter((d) => d.working && d.marked < d.expected).length;

  return (
    <div className="card stack" style={{ gap: 8 }}>
      <div className="row">
        <strong style={{ fontSize: 14 }}>Last {days.length} days</strong>
        {gaps === 0
          ? <span className="badge ok">All marked</span>
          : <span className="badge warn">{gaps} day{gaps === 1 ? '' : 's'} need attention</span>}
      </div>
      <div className="chips">
        {days.map((d) => {
          const dt = new Date(`${d.date}T00:00:00`);
          const label = dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
          const isSel = d.date === selected;
          const complete = d.marked >= d.expected && d.expected > 0;
          const partial = d.marked > 0 && d.marked < d.expected;
          const state = !d.working ? 'off' : complete ? 'done' : partial ? 'partial' : 'missing';
          const tip = !d.working ? 'Holiday or weekly off'
            : complete ? `All ${d.expected} marked`
            : partial ? `Only ${d.marked} of ${d.expected} marked`
            : `Not marked (${d.expected} students)`;
          return (
            <button
              key={d.date}
              type="button"
              className={`chip ${isSel ? 'active' : ''}`}
              disabled={!d.working}
              title={tip}
              onClick={() => onPick(d.date)}
              style={!isSel && d.working && state !== 'done' ? { borderColor: '#d97706' } : undefined}
            >
              {state === 'done' ? '✓' : state === 'off' ? '—' : '⚠'} {label}
              {state === 'partial' && <span className="muted" style={{ fontSize: 11 }}> {d.marked}/{d.expected}</span>}
            </button>
          );
        })}
      </div>
      {gaps > 0 && (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Click a day to fill it in. Absences on past days are recorded but parents aren&apos;t texted.
        </p>
      )}
    </div>
  );
}

export default function AttendancePage() {
  const [classes, setClasses] = useState<Klass[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [sectionId, setSectionId] = useState('');
  const [date, setDate] = useState(today());
  const [session] = useState('MORNING');
  const [rows, setRows] = useState<Enrollment[]>([]);
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [coverage, setCoverage] = useState<DayCoverage[]>([]);
  const [autoLoaded, setAutoLoaded] = useState(false);
  const [unmarked, setUnmarked] = useState<UnmarkedRegisters | null>(null);

  useEffect(() => {
    apiGet<Klass[]>('/classes').then(setClasses).catch(() => {});
    apiGet<Section[]>('/sections').then(setSections).catch(() => {});
    apiGet<Campus[]>('/campuses').then(setCampuses).catch(() => {});
    // Deep-link from "My Classes" (e.g. /attendance?sectionId=…): preselect that section.
    const params = new URLSearchParams(window.location.search);
    const sid = params.get('sectionId');
    if (sid) setSectionId(sid);
    // Arrived from the dashboard's "N registers not marked today" chip: show WHICH ones, or the
    // chip is a number that points at a page where you still have to go looking.
    if (params.get('unmarked')) {
      api.staff.unmarkedRegisters().then(setUnmarked).catch(() => {});
    }
  }, []);

  // Once the deep-linked section is set, load its roster automatically (one time).
  useEffect(() => {
    const sid = new URLSearchParams(window.location.search).get('sectionId');
    if (sid && sectionId === sid && !autoLoaded) {
      setAutoLoaded(true);
      loadRoster().catch(() => {});
    }
  }); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadCoverage(sid = sectionId) {
    if (!sid) return setCoverage([]);
    try {
      setCoverage(await apiGet<DayCoverage[]>(`/attendance/coverage?sectionId=${sid}&session=${session}&days=${BACKFILL_DAYS}`));
    } catch {
      setCoverage([]); // the strip is an aid, never a blocker
    }
  }
  useEffect(() => { loadCoverage().catch(() => {}); }, [sectionId, session]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadRoster() {
    if (!sectionId) return;
    const enr = await apiGet<{ data: Enrollment[] }>(`/enrollments?sectionId=${sectionId}&status=ACTIVE`);
    const existing = await apiGet<Array<{ enrollmentId: string; status: string }>>(`/attendance?sectionId=${sectionId}&date=${date}`);
    const m: Record<string, string> = {};
    for (const e of enr.data) m[e.id] = 'PRESENT';
    for (const a of existing) m[a.enrollmentId] = a.status;
    // Set marks BEFORE rows: the editable table renders on `rows.length > 0`, so seeding
    // marks first ensures the <select>s never render (and can't be changed then clobbered)
    // before their backing state exists — otherwise a status picked during the gap between
    // these two setState calls is overwritten by this setMarks. (Same race we fixed in exams.)
    setMarks(m);
    setRows(enr.data);
    setMsg(null);
  }

  async function save() {
    try {
      const records = rows.map((r) => ({ enrollmentId: r.id, status: marks[r.id] ?? 'PRESENT' }));
      const res = await apiPost<{ succeeded: number; failed: number; absenceQueued: number; absenceNotifiedSuppressed: number }>('/attendance/bulk', { sectionId, date, session, records });
      // Say plainly what happened to the notifications — a silently withheld SMS looks like a
      // bug to a teacher who expects parents to hear about an absence.
      const sms = res.absenceNotifiedSuppressed > 0
        ? `${res.absenceNotifiedSuppressed} absence(s) recorded — parents not texted for a past date`
        : `absence SMS queued ${res.absenceQueued}`;
      setMsg({ ok: res.failed === 0, text: `Saved ${res.succeeded}, failed ${res.failed}, ${sms}` });
      await loadCoverage(); // the day just filled should stop showing as a gap
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to save' });
    }
  }

  const sectionLabel = sectionLabeller(classes, campuses);

  return (
    <div className="stack">
      <h1>Attendance</h1>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {/* Surfaced, not enforced: this names the sections still outstanding and lets the reader
          jump straight into one. Nothing here blocks or punishes anybody. */}
      {unmarked && unmarked.count > 0 && (
        <div className="card stack" style={{ borderLeft: '4px solid #d97706' }}>
          <strong style={{ fontSize: 15 }}>
            {unmarked.count} register{unmarked.count === 1 ? '' : 's'} not marked today
          </strong>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Expected to be marked by {unmarked.markByTime}. Nothing is recorded for these students
            until someone marks them — an unmarked day stays a gap, it is never assumed.
          </p>
          <div className="row" style={{ justifyContent: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
            {unmarked.sections.map((u) => (
              <button key={u.sectionId} type="button" className="chip"
                onClick={() => { setSectionId(u.sectionId); setDate(today()); }}>
                {u.className} {u.sectionName}
                {/* Half-done and never-started are different problems needing different effort. */}
                {u.partial ? ` — ${u.marked}/${u.expected} done` : ''} →
              </button>
            ))}
          </div>
        </div>
      )}
      {date !== today() && (
        <div className="toast warn">
          You&apos;re marking <b>{new Date(date).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</b>,
          not today. Absences will be recorded but <b>parents won&apos;t be texted</b> for a past date.
        </div>
      )}

      <div className="inline-form">
        <div><label>Section</label>
          <select value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
            <option value="">Select…</option>
            {sections.map((s) => <option key={s.id} value={s.id}>{sectionLabel(s)}</option>)}
          </select>
        </div>
        <div><label>Date</label>
          <input type="date" value={date} min={earliest()} max={today()}
            onChange={(e) => setDate(e.target.value)} />
        </div>
        <button className="ghost" onClick={loadRoster} disabled={!sectionId}>Load roster</button>
      </div>

      <CoverageStrip days={coverage} selected={date} onPick={(d) => { setDate(d); setRows([]); }} />

      {rows.length > 0 && (
        <>
          <table>
            <thead><tr><th>GR</th><th>Student</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.student?.grNumber}</td>
                  <td>{r.student?.fullName}</td>
                  <td>
                    <select value={marks[r.id] ?? 'PRESENT'} onChange={(e) => setMarks((prev) => ({ ...prev, [r.id]: e.target.value }))}>
                      {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div><button onClick={save}>Save attendance</button></div>
        </>
      )}
      {sectionId && rows.length === 0 && <p className="muted">No active students in this section — add students first.</p>}
    </div>
  );
}
